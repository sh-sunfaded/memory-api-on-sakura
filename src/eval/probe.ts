// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, memories } from "../../api/[...path]";

// 事前実測プローブ (2026-11-23, さくらコンテスト準備・M1の実測道具):
//   任意のOpenAI互換 /embeddings エンドポイントを、DBを1ビットも変えずに試す。
//   golden の質問と DB内の記憶本文を対象エンドポイントで埋め込み、
//   「質問→記憶」のrank当て(top-1/top-3)を対象の空間の中で完結して測る。
//   これでさくらのAI Engine のモデル名・次元・レイテンシ・精度を見てから
//   schema vector(N) の N を決められる(実測待ち前提の実測器)。
//
//   本番の EMBEDDING_* とは別変数(PROBE_*)なので、.env を共用できる。
//   DBは読み取り専用(SELECTのみ)。書込・更新はしない。
//
// 使い方(.env に PROBE_* を書いて):
//   npm run probe
//   npm run probe -- --max-memories 200 --out report/probe.json
//
// 出力するもの:
//   - 次元数の実測(schema vector(1536) と一致するかの警告付き)
//   - レイテンシ p50/p95/max(1呼び出しごと)
//   - golden質問の top-1/top-3(対象の埋め込み空間の中でのrank当て)
//   - 消費リクエスト数(無料枠10,000の予算表の種)

interface QRow { q: string; expected: string }

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function loadGolden(): Promise<QRow[]> {
  const raw = await readFile(new URL("../../data/golden.csv", import.meta.url), "utf8");
  return raw.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("q,"))
    .map((line) => {
      const cols = splitCsvLine(line).filter((s) => s !== "");
      return { q: cols[0], expected: cols[cols.length - 1] };
    })
    .filter((r) => r.q && r.expected);
}

// 対象エンドポイントへの1回の埋め込み呼び出し(exact 1 request)
async function probeEmbed(
  texts: string[], baseUrl: string, apiKey: string, model: string,
): Promise<{ vecs: number[][]; ms: number; status: number }> {
  const t0 = performance.now();
  const res = await fetch(baseUrl.replace(/\/+$/, "") + "/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model, input: texts }),
  });
  const ms = performance.now() - t0;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("probe embedding failed: HTTP " + res.status + " " + detail.slice(0, 300));
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vecs = (json.data ?? []).map((d) => (d.embedding ?? []).map(Number));
  return { vecs, ms, status: res.status };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const baseUrl = process.env.PROBE_BASE_URL;
  const apiKey = process.env.PROBE_API_KEY;
  const model = process.env.PROBE_MODEL;
  if (!baseUrl || !apiKey || !model) {
    console.error("PROBE_BASE_URL / PROBE_API_KEY / PROBE_MODEL が未設定 (本番 EMBEDDING_* とは別変数)");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const maxIdx = args.indexOf("--max-memories");
  const maxMemories = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 100;
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

  // 1) DBから記憶を読む(読み取り専用)
  const rows = await db.select({
    id: memories.id,
    title: memories.title,
    content: memories.content,
  }).from(memories)
    .where(eq(memories.status, "active"))
    .limit(Number.isFinite(maxMemories) ? maxMemories : 100);

  const golden = await loadGolden();
  if (rows.length === 0 || golden.length === 0) {
    console.error("DB または golden.csv が空");
    process.exit(1);
  }
  console.log("probing target:", baseUrl);
  console.log("memories:", rows.length, "/ golden:", golden.length);

  // 2) 対象の空間で埋め直す(記憶本文は本番と同じ title+content)
  const latencies: number[] = [];
  let requests = 0;
  let dims = 0;

  const memVecs: number[][] = [];
  for (const r of rows) {
    // 本文が長い場合は本番 embed() と同じ切り詰め
    const text = (r.title + "\n" + r.content).slice(0, 30000);
    const { vecs, ms } = await probeEmbed([text], baseUrl, apiKey, model);
    latencies.push(ms);
    requests++;
    dims = vecs[0]?.length ?? dims;
    memVecs.push(vecs[0] ?? []);
  }

  const qVecs: number[][] = [];
  const qLat: number[] = [];
  for (const g of golden) {
    const { vecs, ms } = await probeEmbed([g.q], baseUrl, apiKey, model);
    latencies.push(ms);
    qLat.push(ms);
    requests++;
    qVecs.push(vecs[0] ?? []);
  }

  // 3) rank当て: golden の期待IDが top-1/top-3 に入るか(対象空間内で完結)
  let top1 = 0, top3 = 0;
  const missDetail: string[] = [];
  const perQ: Array<{ q: string; hit: boolean; hit3: boolean; got: string | null }> = [];
  for (let qi = 0; qi < golden.length; qi++) {
    const scored = rows.map((r, ri) => ({ id: r.id, sim: cosine(qVecs[qi], memVecs[ri]) }))
      .sort((a, b) => b.sim - a.sim).slice(0, 3);
    const hit = scored[0]?.id === golden[qi].expected;
    const hit3 = scored.some((s) => s.id === golden[qi].expected);
    if (hit) top1++;
    if (hit3) top3++;
    else missDetail.push(golden[qi].q + " -> got: " + (scored[0]?.id ?? "(none)"));
    perQ.push({ q: golden[qi].q, hit, hit3, got: scored[0]?.id ?? null });
  }

  const sortedLat = [...latencies].sort((a, b) => a - b);
  const report = {
    date: new Date().toISOString(),
    target: { base_url: baseUrl, model },
    dims,
    dims_match_schema_1536: dims === 1536,
    memories: rows.length,
    golden_queries: golden.length,
    top1: Number((top1 / golden.length).toFixed(3)),
    top3: Number((top3 / golden.length).toFixed(3)),
    latency_ms: {
      p50: Math.round(percentile(sortedLat, 50)),
      p95: Math.round(percentile(sortedLat, 95)),
      max: Math.round(sortedLat[sortedLat.length - 1] ?? 0),
    },
    embedding_requests: requests,
    misses: missDetail,
    per_query: perQ,
  };

  console.log("dims:", dims, dims === 1536 ? "(schema vector(1536) と一致)" : "!! schema vector(1536) と不一致。schemaのNを実測次元に合わせ直すこと");
  console.log("top-1:", top1 + "/" + golden.length, "=", report.top1);
  console.log("top-3:", top3 + "/" + golden.length, "=", report.top3);
  console.log("latency(ms) p50:", report.latency_ms.p50, "p95:", report.latency_ms.p95, "max:", report.latency_ms.max);
  console.log("embedding requests:", requests);
  if (missDetail.length > 0) console.log("misses:\n  " + missDetail.join("\n  "));

  if (outFile) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync("report", { recursive: true });
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log("report written: " + outFile);
  }
  process.exit(0);
}
main();
