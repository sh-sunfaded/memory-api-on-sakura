// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "../api/[...path]";

// 単体起動サーバー。server 本体は api/[...path].ts に統合済み。
// 素の node-server で app を直に立てる(本番の systemd からもこれを起動する)。
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log("memory_api dev -> http://localhost:" + info.port + "/healthz");
});
