// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, memories } from "../../api/[...path]";

// 類似度分布ダンプ (2026-11-23, さくらコンテスト準備・409閾値較正の基線測定):
//   DB内の active 記憶の埋め込みを全件読み、ペアごとのコサイン類似度分布を出す。
//   基線として最初に一回回し、埋め込み空間が変わったら同じものを回し直す。
//   閾値は空間ごとのこの分布の実測の上に載せる (0.85は初手の仮置き)。
//
//   読み取り専用(SELECTのみ)。埋め込みAPIは呼ばないのでリクエスト消費ゼロ。
//
// 使い方:
//   npm run simdistr                      ... 標準出力にサマリ+上位ペア
//   npm run simdistr -- --out report/a.json ... JSONをファイルにも書く
//
// 出力するもの:
//   - 件数・次元の実測
//   - 全ペア類似度のヒストグラム(0.50〜1.00を0.05刻み)
//   - 上位20近傍ペア(どの記憶同士が近いか = 409差戻しの温床)
//   - 最近傍類似度(per-memory nearest)の p50/p90/p99
//     (= 「次に書く内容が 既存の何とかぶるか」の実測分布。閾値はこの上に載せる)

type Row = { id: string; title: string; scopeType: string; scopeId: string; vec: number[] }

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const main = async () => {
  const outFlag = process.argv.indexOf("--out");
  const outFile = outFlag >= 0 ? process.argv[outFlag + 1] : null;

  const rowsRaw = await db.select({
    id: memories.id,
    title: memories.title,
    scopeType: memories.scopeType,
    scopeId: memories.scopeId,
    embedding: memories.embedding,
    embeddingModel: memories.embeddingModel,
  }).from(memories)
    .where(and(eq(memories.status, "active")));

  const rows: Row[] = rowsRaw
    .filter((r) => Array.isArray(r.embedding) && r.embedding.length > 0)
    .map((r) => ({
      id: r.id,
      title: r.title,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      vec: r.embedding as number[],
    }));

  if (rows.length < 2) {
    console.error("active な埋め込み付き記憶が2件未満。分布は出せない");
    process.exit(1);
  }

  const dims = new Set(rows.map((r) => r.vec.length));
  console.log("memories:", rows.length, "/ dims:", [...dims].join(", "));

  // ヒストグラム(0.50未満は1つの枠にまとめる)
  const BUCKET_MIN = 0.5, BUCKET_W = 0.05;
  const buckets = new Map<string, number>();
  const pairSims: Array<{ i: number; j: number; sim: number }> = [];
  const nearest = new Array<number>(rows.length).fill(0);

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = cosine(rows[i].vec, rows[j].vec);
      pairSims.push({ i, j, sim });
      if (sim > nearest[i]) nearest[i] = sim;
      if (sim > nearest[j]) nearest[j] = sim;
      let key: string;
      if (sim < BUCKET_MIN) key = "<0.50";
      else {
        const lo = Math.floor((sim - BUCKET_MIN) / BUCKET_W) * BUCKET_W + BUCKET_MIN;
        key = lo.toFixed(2) + "-" + (lo + BUCKET_W).toFixed(2);
      }
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }

  const topPairs = [...pairSims].sort((a, b) => b.sim - a.sim).slice(0, 20)
    .map((p) => ({
      sim: Number(p.sim.toFixed(4)),
      same_scope: rows[p.i].scopeType === rows[p.j].scopeType && rows[p.i].scopeId === rows[p.j].scopeId,
      a: { id: rows[p.i].id, title: rows[p.i].title, scope: rows[p.i].scopeType + ":" + rows[p.i].scopeId },
      b: { id: rows[p.j].id, title: rows[p.j].title, scope: rows[p.j].scopeType + ":" + rows[p.j].scopeId },
    }));

  const allSims = pairSims.map((p) => p.sim).sort((a, b) => a - b);
  const nearestSorted = [...nearest].sort((a, b) => a - b);
  const over085 = allSims.filter((s) => s > 0.85).length;

  console.log("pairs:", pairSims.length, "/ sim>0.85:", over085);
  console.log("histogram:");
  for (const [k, v] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    console.log("  " + k + " " + "#".repeat(Math.min(40, v)) + " " + v);
  }
  console.log("pair sim p50/p90/p99/max:",
    percentile(allSims, 50).toFixed(3),
    percentile(allSims, 90).toFixed(3),
    percentile(allSims, 99).toFixed(3),
    allSims[allSims.length - 1].toFixed(3));
  console.log("nearest-neighbor p50/p90/p99:",
    percentile(nearestSorted, 50).toFixed(3),
    percentile(nearestSorted, 90).toFixed(3),
    percentile(nearestSorted, 99).toFixed(3));
  console.log("top 20 pairs:");
  for (const p of topPairs) {
    console.log("  " + p.sim.toFixed(4) + (p.same_scope ? " [同scope] " : " [横scope] ")
      + p.a.title + "  <->  " + p.b.title);
  }

  if (outFile) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    // v2.1: 出力先ディレクトリが無ければ作る(ENOENT対策)
    const dir = outFile.includes("/") ? outFile.replace(/\/[^/]+$/, "") : "";
    if (dir !== "") mkdirSync(dir, { recursive: true });
    const report = {
      date: new Date().toISOString(),
      model: rowsRaw.find((r) => r.embeddingModel)?.embeddingModel ?? null,
      memories: rows.length,
      dims: [...dims],
      pairs: pairSims.length,
      over_085: over085,
      histogram: Object.fromEntries(buckets),
      pair_sim: {
        p50: Number(percentile(allSims, 50).toFixed(4)),
        p90: Number(percentile(allSims, 90).toFixed(4)),
        p99: Number(percentile(allSims, 99).toFixed(4)),
        max: Number(allSims[allSims.length - 1].toFixed(4)),
      },
      nearest_neighbor: {
        p50: Number(percentile(nearestSorted, 50).toFixed(4)),
        p90: Number(percentile(nearestSorted, 90).toFixed(4)),
        p99: Number(percentile(nearestSorted, 99).toFixed(4)),
      },
      top_pairs: topPairs,
    };
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log("report written: " + outFile);
  }
  process.exit(0);
}
main();
