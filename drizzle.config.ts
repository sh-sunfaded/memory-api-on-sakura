// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// 接続先はPostgreSQL接続文字列 (DATABASE_URL)。
// schema は server 本体 (api/[...path].ts) から drizzle が table を拾う
// (本体が single source of truth)。ただし drizzle-kit はパス内の `[...]` を
// glob として解釈するため、再輸出だけの src/db/schema.ts を指定する (M01)。
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
