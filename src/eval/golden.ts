// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseBody, SearchMemory, searchMemories } from "../../api/[...path]";

// golden評価 v2.2 (2026-11-23, さくらコンテスト準備):
//   - CSV は2形式を取る。旧: q,expected_id / 新: q,scope,expected_id (scopeは"type:id")
//   - 各検索の所要時間を測り、p50/p95 を報告する(運用が揃うと時系列の比較資料になる)
//   - 埋め込みリクエスト数を計上する(無料枠の予算表の種)
//   - --json を付けると report/ に機械可読レポートを書き出す
//   - v2.2: goldenのscopeは期待IDの通り project:memory_api に固定。DEFAULT_SCOPE_*
//     環境変数が予想外の値でも検収が揺れないようにした(環境変数の汚染事故への実測対応)。
//     CSVにscope列がある行はそちらを優先する。
// GATE は30問体制から効く。判定条件は旧版と同一。
// M06 (2026-11-24): splitCsvLine の引用符外の列が1字も蓄積されない欠損を修正。
//   else 節が無かったため旧2列CSV (q quoted / expected_id 素) も全行 skip で
//   golden eval が実行不能になっていた (node 実機再現で確定)。1行追加のみ。
const GATE_TOP1 = 0.7;
const GATE_TOP3 = 0.9;
const GOLDEN_SCOPE = { type: "project", id: "memory_api" } as const;

type GoldenRow = { q: string; scope: { type: string; id: string }; expected: string }

// 引用符を含む最小CSV行パーサ(golden.csvの""対応)
const splitCsvLine = (line: string): string[] => {
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

const parseScope = (s: string): { type: string; id: string } | null => {
  // "project:rinka" 形式。不一致なら null (= GOLDEN_SCOPE にfallback)
  const m = s.match(/^(project|user):([^\s:]+)$/);
  return m ? { type: m[1], id: m[2] } : null;
}

const loadGolden = async (): Promise<GoldenRow[]> => {
  const raw = await readFile(new URL("../../data/golden.csv", import.meta.url), "utf8");
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
  if (lines.length === 0) throw new Error("golden.csv が空");

  const header = splitCsvLine(lines[0]).map((s) => s.toLowerCase());
  const hasScope = header.length >= 3 && header.some((h) => h.startsWith("scope"));

  const rows: GoldenRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line).filter((s) => s !== "");
    if (cols.length === 0) continue;
    if (hasScope) {
      if (cols.length < 3) { console.error("skip (3列必要): " + line); continue; }
      rows.push({ q: cols[0], scope: parseScope(cols[1]) ?? GOLDEN_SCOPE, expected: cols[cols.length - 1] });
    } else {
      if (cols.length < 2) { console.error("skip (2列必要): " + line); continue; }
      rows.push({ q: cols[0], scope: GOLDEN_SCOPE, expected: cols[cols.length - 1] });
    }
  }
  return rows;
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const validScope = (s: { type: string; id: string }): boolean => {
  return s.type.trim() === "project" && s.id.trim() !== "";
}

const main = async () => {
  const asJson = process.argv.includes("--json");

  // Secretプレースホルダーの事前検出(envの未設定・プレースホルダー残りを弾く)
  for (const name of ["EMBEDDING_BASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL"]) {
    const v = process.env[name];
    if (!v || v.includes("[SENSITIVE]")) {
      console.error("ENV-FAIL: " + name + " が未設定。.env に実値を手で整えること");
      process.exit(2);
    }
  }

  const rows = await loadGolden();
  if (rows.length === 0) { console.error("golden.csv に有効行が無い"); process.exit(1); }

  let top1 = 0, top3 = 0;
  const misses: string[] = [];
  const latencies: number[] = [];
  const perQuery: Array<{ q: string; hit: boolean; top3_hit: boolean; ms: number }> = [];

  for (const row of rows) {
    const scope = validScope(row.scope) ? { type: "project", id: row.scope.id.trim() } : GOLDEN_SCOPE;
    const parsed = parseBody(SearchMemory)({ scope, q: row.q, limit: 3 });
    if (!parsed.success) {
      console.error("invalid query: " + row.q
        + "\n  issues: " + JSON.stringify(parsed.error.issues));
      continue;
    }
    const t0 = performance.now();
    const res = await searchMemories(parsed.data);
    const ms = performance.now() - t0;
    latencies.push(ms);
    const ids = res.results.map((r) => r.id);
    const hit = ids[0] === row.expected;
    const hit3 = ids.includes(row.expected);
    if (hit) top1++;
    if (hit3) top3++;
    else misses.push(row.q + " -> got: " + (ids[0] ?? "(none)"));
    perQuery.push({ q: row.q, hit, top3_hit: hit3, ms: Math.round(ms) });
  }

  if (latencies.length === 0) {
    console.error("検索が1件も実行できなかった(env・入力の問題)。上の ENV-FAIL / invalid 行を参照のこと");
    process.exit(2);
  }

  const top1Rate = top1 / rows.length;
  const top3Rate = top3 / rows.length;
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const report = {
    date: new Date().toISOString(),
    model: process.env.EMBEDDING_MODEL ?? null,
    threshold: process.env.SIM_THRESHOLD ?? "0.85",
    queries: rows.length,
    top1: Number(top1Rate.toFixed(3)),
    top3: Number(top3Rate.toFixed(3)),
    latency_ms: {
      p50: Math.round(percentile(sortedLat, 50)),
      p95: Math.round(percentile(sortedLat, 95)),
      max: Math.round(sortedLat[sortedLat.length - 1] ?? 0),
    },
    embedding_requests: rows.length, // 検索1件 = 埋め込み1リクエスト(予算表の種)
    misses,
    per_query: perQuery,
  };

  console.log("golden:", rows.length, "queries");
  console.log("top-1:", top1 + "/" + rows.length, "=", top1Rate.toFixed(2));
  console.log("top-3:", top3 + "/" + rows.length, "=", top3Rate.toFixed(2));
  console.log("latency(ms) p50:", report.latency_ms.p50, "p95:", report.latency_ms.p95, "max:", report.latency_ms.max);
  if (misses.length > 0) console.log("misses:\n  " + misses.join("\n  "));

// L4 (第1報, 2026-11-24): ゲートは30問体制から効く (10問の暫定敷居は廃止)。
  if (rows.length < 30) {
    console.log("NOTE: 30問未満なので率は参考値。本戦は30問に育てる");
  } else {
    if (top1Rate < GATE_TOP1 || top3Rate < GATE_TOP3) {
      console.error("GATE FAILED: top1>=" + GATE_TOP1 + " top3>=" + GATE_TOP3);
      if (asJson) console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    console.log("GATE PASSED");
  }

  if (asJson) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
    mkdirSync("report", { recursive: true });
    writeFileSync("report/golden-" + stamp + ".json", JSON.stringify(report, null, 2));
    console.log("report written: report/golden-" + stamp + ".json");
  }
}
main();
