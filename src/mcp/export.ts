// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CorrectMemory, ContextQuery, SearchMemory, WriteMemory } from "../../api/[...path]";

// AI読み口（MCP/Function Calling）の inputSchema を zod から生成。
// 型は zod に一本化（§12.1 防衛条項2: 型の重複を持たない）。
// NOTE: zod-to-json-schema 3.24 は zod 3.24 の内部型に追従していないため
// cast で通す。ランタイムは zod の .parse ベースなので動作に影響なし。
// 業務規則 (typeRuleIssues・排他) はサーバー側の parse が担うので、
// スキーマ出力には乗らない。
//
// H6 (2026-11-24 報告書): 広告 (inputSchema) が null を許すかどうかは
// 形状の推測に頼らず、その場で null を parse してみた実測から引く。
// 実行時に拒否する項目は null 枝を落とし、実行時に受理する項目は
// null 枝を1本だけ残す。schema-ads.test.ts が往復を固定する。
//
// H7 (改訂4, 2026-11-24): 枝が1本に畳まれた anyOf は「anyOf: { 枝 }」の
// オブジェクト形として残さず、キーごと消して親へ展開する (JSON Schema の
// anyOf は配列でなければならない)。schema-ads.test.ts が全 anyOf の
// 配列性を検査する。

const S = (s: never) => zodToJsonSchema(s);

// WriteMemory は superRefine 付きの ZodEffects で .omit を持たないため、
// 内側の ZodObject を取り出してから omit する (M01: CI typecheck が拾った既存エラー)。
// refine の検査(排他・必須)はサーバー側の parse が担うので、スキーマ出力には影響しない。
const WriteMemoryObject = (WriteMemory as unknown as { _def: { schema: z.ZodObject<z.ZodRawShape> } })._def.schema;

const probeBase: Record<string, Record<string, unknown>> = {
  memory_search: { q: "x", scope: { type: "project", id: "x" } },
  memory_context: { scope: { type: "project", id: "x" } },
  memory_write: { type: "fact", scope: { type: "project", id: "x" }, title: "t", content: "c" },
  memory_correct: { id: "00000000-0000-0000-0000-000000000000" },
};

const isNullBranch = (node: unknown): boolean =>
  typeof node === "object" && node !== null &&
  (node as Record<string, unknown>).type === "null";

// H7 (改訂4, 2026-11-24): JSON Schema の anyOf は配列でなければならない。
// 1本に畳まれた anyOf はオブジェクト形で残さず、枝の内容を親へ展開する。
// anyOf は AND 意味論なので、枝と親で衝突しないキー同士の併合が等価に
// なる (衝突したら親を守る)。
const mergeIntoParent = (out: Record<string, unknown>, branch: unknown): void => {
  if (typeof branch !== "object" || branch === null || Array.isArray(branch)) return;
  for (const [bk, bv] of Object.entries(branch as Record<string, unknown>)) {
    if (!(bk in out)) out[bk] = bv;
  }
};

// 実行時に null を拒否する項目: null枝を全部落とす
const dropNullBranches = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(dropNullBranches);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k !== "anyOf") {
      out[k] = dropNullBranches(v);
      continue;
    }
    const kept = (v as unknown[]).filter((m) => !isNullBranch(m)).map(dropNullBranches);
    if (kept.length === 0) continue;
    if (kept.length === 1) { mergeIntoParent(out, kept[0]); continue; }
    out[k] = kept;
  }
  return out;
};

// 実行時に null を受理する項目: 入れ子 anyOf を平坦化し null枝は1本だけ残す
const keepSingleNull = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(keepSingleNull);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k !== "anyOf") {
      out[k] = keepSingleNull(v);
      continue;
    }
    const flat: unknown[] = [];
    let nullSeen = false;
    const walk = (m: unknown): void => {
      if (isNullBranch(m)) {
        if (!nullSeen) {
          nullSeen = true;
          flat.push(m);
        }
        return;
      }
      if (typeof m === "object" && m !== null && Array.isArray((m as Record<string, unknown>).anyOf)) {
        (m as unknown as { anyOf: unknown[] }).anyOf.forEach(walk);
        return;
      }
      flat.push(keepSingleNull(m));
    };
    (v as unknown[]).forEach(walk);
    // H7 (改訂4, 2026-11-24): 1本に畳まれた anyOf はオブジェクト形に残さず親へ展開
    if (flat.length === 1) { mergeIntoParent(out, flat[0]); continue; }
    out[k] = flat;
  }
  return out;
};

// H6 (2026-11-24 報告書): 広告の null 可否は実行時の parse 実測から引く。
const honestize = (name: string, schema: z.ZodType): Record<string, unknown> => {
  const out = { ...S(schema as never) } as Record<string, unknown>;
  delete out.$schema;
  const props = (out.properties ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(props)) {
    const r = schema.safeParse({ ...probeBase[name], [key]: null });
    props[key] = r.success ? keepSingleNull(props[key]) : dropNullBranches(props[key]);
  }
  return out;
};

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const writeTool = WriteMemoryObject.omit({ id: true }) as unknown as z.ZodType;

export const buildTools = (): Tool[] => [
  {
    name: "memory_search",
    description: "記憶を意味検索して「なぜ」に答える。判断前に必ず呼ぶ。",
    inputSchema: honestize("memory_search", SearchMemory),
  },
  {
    name: "memory_context",
    description: "前提の要約（制約＋直近の決定）を取得。会話の冒頭で渡す。",
    inputSchema: honestize("memory_context", ContextQuery),
  },
  {
    name: "memory_write",
    description: "決定・事実・制約・好み・TODOを書く。decisionはevidence+reason必須。類似0.85超は409で差し戻される。",
    inputSchema: honestize("memory_write", writeTool),
  },
  {
    name: "memory_correct",
    description: "記憶を訂正する。旧内容はrevision履歴にsnapshotとして残る。",
    inputSchema: honestize("memory_correct", CorrectMemory),
  },
];

// npm run mcp として実行されたときだけ書き出す (vitest 等からの import では書かない)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tools = buildTools();
  mkdirSync("mcp", { recursive: true });
  writeFileSync("mcp/tools.json", JSON.stringify({ tools }, null, 2));
  console.log("mcp/tools.json written (" + tools.length + " tools)");
}
