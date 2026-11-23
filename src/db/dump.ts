// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import "dotenv/config";
import { db, memories, memoryRevisions } from "../../api/[...path]";

// 記憶エクスポート (2026-11-23, さくらコンテスト準備・バックアップと移し替えの道具):
//   全記憶と全履歴(revision snapshot)を JSON で吐き出す。別環境(Postgres側)で
//   1) 件数・revision連番の突き合わせ検収
//   2) 再埋め込み(次元変更時は旧ベクトルは使い回せない。本文から作り直す)
//   に使う。読み取り専用。
//
//   既定では embedding(ベクトル) は **含めない**。次元が変わる移し替えでは
//   使い回せず、かつ容量が重い。--with-embedding で温存用に含められる。
//
// 使い方:
//   npm run dump -- --out data/dump-20261123.json
//   npm run dump -- --out data/dump-full.json --with-embedding

function iso(d: Date | null): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : "data/memory-dump.json";
  const withEmbedding = args.includes("--with-embedding");

  const memRows = await db.select().from(memories);
  const revRows = await db.select().from(memoryRevisions);

  console.log("memories:", memRows.length, "/ revisions:", revRows.length,
    withEmbedding ? "(embedding込み)" : "(embedding除外)");

  const dump = {
    date: new Date().toISOString(),
    source: process.env.DATABASE_URL ? "configured DATABASE_URL" : "(none)",
    counts: { memories: memRows.length, revisions: revRows.length },
    memories: memRows.map((m) => ({
      id: m.id,
      type: m.type,
      scope: { type: m.scopeType, id: m.scopeId },
      title: m.title,
      content: m.content,
      reason: m.reason,
      evidence: m.evidence,
      trust: m.trust,
      status: m.status,
      supersedes: m.supersedes,
      tags: m.tags,
      valid_from: iso(m.validFrom),
      expires_at: iso(m.expiresAt),
      created_by: m.createdBy,
      revision: m.revision,
      embedding_model: m.embeddingModel,
      ...(withEmbedding ? { embedding: m.embedding } : {}),
    })),
    revisions: revRows.map((r) => ({
      memoryId: r.memoryId,
      revision: r.revision,
      event: r.event,
      changed_by: r.changedBy,
      changed_at: iso(r.changedAt),
      note: r.note,
      snapshot: r.snapshot,
    })),
  };

  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = outFile.includes("/") ? outFile.replace(/\/[^/]+$/, "") : ".";
  if (dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(dump, null, 2));
  console.log("dump written: " + outFile);

  // 突き合わせ検収の種: ステータス別件数と、revision の穴の有無
  const byStatus: Record<string, number> = {};
  for (const m of memRows) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  const perMemory = new Map<string, number>();
  for (const r of revRows) perMemory.set(r.memoryId, (perMemory.get(r.memoryId) ?? 0) + 1);
  console.log("status:", JSON.stringify(byStatus));
  console.log("memories with revisions:", perMemory.size);
  process.exit(0);
}
main();
