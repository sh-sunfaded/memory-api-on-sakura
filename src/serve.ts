// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { createServer } from "node:http";
import handler from "../api/[...path]";

// 単体起動サーバー (本番の systemd からもこれを起動する)。
// server 本体は api/[...path].ts に統合済み。default export が legacy
// (req, res) 契約を既に持っているので、そのまま node:http に載せる。
const port = Number(process.env.PORT ?? 3000);
const server = createServer(handler as (req: any, res: any) => void);
server.listen(port, () => {
  console.log("memory_api dev -> http://localhost:" + port + "/healthz");
});
