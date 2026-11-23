// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { apiTokens, db, hashToken } from "../../api/[...path]";

// トークン発行: npm run token -- <name> <read|write|admin>
// secret は二度と表示されない（DB には sha256 ハッシュのみ置く）
async function main() {
  const [name, role] = process.argv.slice(2);
  if (!name || !role || !["read", "write", "admin"].includes(role)) {
    console.error("usage: npm run token -- <name> <read|write|admin>");
    process.exit(1);
  }
  const secret = "mem_" + randomBytes(24).toString("base64url");
  await db.insert(apiTokens).values({
    name, role: role as "read" | "write" | "admin", tokenHash: hashToken(secret),
  });
  console.log("token created (shown once): " + secret);
  process.exit(0);
}
main();
