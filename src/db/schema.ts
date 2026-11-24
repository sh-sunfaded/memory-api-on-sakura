// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// drizzle-kit push 用の schema 入口 (M01)。
// 本体は api/[...path].ts が single source of truth。ここから再輸出するだけ。
// drizzle-kit は schema パス内の `[...]` を glob 文字として解釈して
// 直接指定すると "No schema files found" になるため、括弧を含まない
// このファイルを drizzle.config.ts の schema に指定する。
// pgEnum は pgTable とは独立した export なので、push が CREATE TYPE を
// 出せるようテーブルだけでなく enum も必ず再輸出すること (テーブルだけだと
// CREATE TABLE の "memory_type" 参照が 42704 になる)。
export {
  memoryType,
  memoryStatus,
  trustLevel,
  tokenRole,
} from "../../api/[...path]";
export {
  apiTokens,
  idempotencyKeys,
  memories,
  memoryRevisions,
  ratelimits,
  referenceLogs,
} from "../../api/[...path]";
