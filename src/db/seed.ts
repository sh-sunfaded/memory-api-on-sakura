// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createMemory, WriteMemory } from "../../api/[...path]";

// 設計対話の決定を種として流し込む（ADRへのURLが根拠になる）
async function main() {
  const raw = await readFile(new URL("../../data/seed.json", import.meta.url), "utf8");
  const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
  let ok = 0, fail = 0;
  for (const item of rows) {
    const parsed = WriteMemory.safeParse(item);
    if (!parsed.success) {
      console.error("skip (invalid):", item.title, "->", parsed.error.issues[0]?.message);
      fail++;
      continue;
    }
    try {
      const row = await createMemory(parsed.data, "seed:design-dialog-2026-11");
      ok++;
      console.log("seeded:", row.id, row.title);
    } catch (e) {
      console.error("skip (conflict):", item.title, "->", e instanceof Error ? e.message : e);
      fail++;
    }
  }
  console.log("done. ok=" + ok + " fail=" + fail);
  process.exit(0);
}
main();
