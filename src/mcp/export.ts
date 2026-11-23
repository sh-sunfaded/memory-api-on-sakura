// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CorrectMemory, ContextQuery, SearchMemory, WriteMemory } from "../../api/[...path]";

// AI読み口（MCP/Function Calling）の inputSchema を zod から生成。
// 型は zod に一本化（§12.1 防衛条項2: 型の重複を持たない）。
// NOTE: zod-to-json-schema 3.24 は zod 3.24 の内部型に追従していないため
// cast で通す。ランタイムは zod の .parse ベースなので動作に影響なし。
const S = (s: never) => zodToJsonSchema(s);

const tools = [
  {
    name: "memory_search",
    description: "記憶を意味検索して「なぜ」に答える。判断前に必ず呼ぶ。",
    inputSchema: S(SearchMemory as never),
  },
  {
    name: "memory_context",
    description: "前提の要約（制約＋直近の決定）を取得。会話の冒頭で渡す。",
    inputSchema: S(ContextQuery as never),
  },
  {
    name: "memory_write",
    description: "決定・事実・制約・好み・TODOを書く。decisionはevidence+reason必須。類似0.85超は409で差し戻される。",
    inputSchema: S(WriteMemory.omit({ id: true }) as never),
  },
  {
    name: "memory_correct",
    description: "記憶を訂正する。旧内容はrevision履歴にsnapshotとして残る。",
    inputSchema: S(CorrectMemory as never),
  },
];

mkdirSync("mcp", { recursive: true });
writeFileSync("mcp/tools.json", JSON.stringify({ tools }, null, 2));
console.log("mcp/tools.json written (" + tools.length + " tools)");
