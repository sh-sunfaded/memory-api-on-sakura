// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// 【なぜこのファイルが1ファイルなのか】
//  - server 本体 (schema/db/auth/ratelimit/embedding/guard/memories/
//    bots/cron/routes/handler) を1ファイルに統合し、相対 import はゼロ。
//    単体の node でそのまま起動でき、動作の全体がひと目で観測できる。
//  - db client は lazy Proxy。module scope での接続・env読み取りは無いので、
//    import だけでは何も起きない (drizzle-kit やトークン発行ツールからも
//    import されるため、この性質が必須)。
//  - 末尾に dual-contract (legacy (req,res) / web-standard Request) の
//    export default を置く。hono の handle は不使用。
//
// 構成 (元ファイル順):
//   schema ← src/db/schema.ts / client ← src/db/index.ts
//   errors ← src/lib/errors.ts / validators ← src/lib/zod.ts
//   auth ← src/lib/auth.ts / ratelimit ← src/lib/ratelimit.ts
//   embedding ← src/lib/embedding.ts / guard ← src/lib/guard.ts
//   memories ← src/lib/memories.ts
//   github ← src/bots/github.ts / slack ← src/bots/slack.ts
//   crons ← src/cron/ttl-sweep.ts + src/cron/audit-export.ts
//   routes ← src/api/app.ts / handler ← src/entry.ts

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono";
import type { Context } from "hono";
import postgres from "postgres";
import { z } from "zod";

// ===== schema (src/db/schema.ts) =====

// pgvector。次元は vector(N) の N に採用モデルの実測次元を当てる(現状は 1536 の仮置き。
// probe 実測で確定して直す)。値はJSの数値配列、ドライバにはJSON文字列 "[1,2,...]" を渡す
export const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() { return "vector(1536)"; },
  toDriver(value: number[]) { return JSON.stringify(value); },
  fromDriver(value: string): number[] { return JSON.parse(value); },
});

export interface EvidenceItem { kind: string; ref: string; quote?: string }

export const memoryType = pgEnum("memory_type", ["decision", "fact", "constraint", "preference", "todo"]);
export const memoryStatus = pgEnum("memory_status", ["active", "superseded", "expired", "deleted"]);
export const trustLevel = pgEnum("trust_level", ["verified", "provisional", "external"]);
export const tokenRole = pgEnum("token_role", ["read", "write", "admin"]);

export const memories = pgTable("memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: memoryType("type").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  reason: text("reason"),
  evidence: jsonb("evidence").$type<EvidenceItem[]>().notNull().default([]),
  embedding: vector1536("embedding"),
  embeddingModel: text("embedding_model"),
  trust: trustLevel("trust").notNull().default("provisional"),
  status: memoryStatus("status").notNull().default("active"),
  supersedes: uuid("supersedes"),
  tags: text("tags").array().notNull().default([]),
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (t) => [
  index("memories_scope_idx").on(t.scopeType, t.scopeId, t.type).where(sql`status = 'active'`),
  index("memories_expires_idx").on(t.expiresAt).where(sql`status = 'active' AND expires_at IS NOT NULL`),
  index("memories_supersedes_idx").on(t.supersedes),
]);

// 変更・削除・期限切れの全履歴（append-only, 仕様書 §3.2）
export const memoryRevisions = pgTable("memory_revisions", {
  memoryId: uuid("memory_id").notNull().references(() => memories.id),
  revision: integer("revision").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  event: text("event").notNull(), // correct | supersede | delete | expire | restore
  changedBy: text("changed_by").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  note: text("note"),
}, (t) => [primaryKey({ columns: [t.memoryId, t.revision] })]);

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  role: tokenRole("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// 実行形態によらず一貫させるため、レート制限はDBベース（§12.5）
export const ratelimits = pgTable("ratelimits", {
  subject: text("subject").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
  count: integer("count").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.subject, t.windowStart] })]);

// 会計層の種: 全窓口の参照ログ
export const referenceLogs = pgTable("reference_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").notNull(), // write | search | context
  subject: text("subject").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  query: text("query"),
  resultCount: integer("result_count"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type MemoryRow = typeof memories.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;

const schema = { memories, memoryRevisions, apiTokens, idempotencyKeys, ratelimits, referenceLogs };

// ===== db lazy client (src/db/index.ts) =====

// 遅延初期化: module scope での pool 生成は事故る(env が無い時に読み込み全体が死ぬ)。
// 初アクセス時に作る。環境変数が無い時はそのリクエストだけが死ぬ。
function makeDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (PostgreSQL の接続文字列を .env に置くこと)");
  }
  // プーラー(transaction mode) + prepared statements 無効化（§12.1）
  const client = postgres(url, { prepare: false, max: 10 });
  return drizzle(client, { schema });
}

let _db: ReturnType<typeof makeDb> | null = null;

export const db: ReturnType<typeof makeDb> = new Proxy(
  {} as ReturnType<typeof makeDb>,
  {
    get(_t, prop) {
      _db ??= makeDb();
      const val = Reflect.get(_db as object, prop, _db as object);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(_db) : val;
    },
  },
);

// ===== errors (src/lib/errors.ts) =====

export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
    public detail?: unknown,
  ) { super(message); }
}

// 409差し戻し（書込摩擦, §5.1）。candidates に類似記憶を載せる
export class ConflictError extends ApiError {
  constructor(
    public subtype: string,
    public candidates: unknown[],
    message = "similar memories exist",
  ) { super(409, "similar-memories", message, { subtype }); }
}

// ===== validators (src/lib/zod.ts) =====

export const MemoryType = z.enum(["decision", "fact", "constraint", "preference", "todo"]);
export type MemoryTypeT = z.infer<typeof MemoryType>;

export const Scope = z.object({
  type: z.enum(["project", "user"]),
  id: z.string().min(1).max(100),
});
export type ScopeT = z.infer<typeof Scope>;

// 根拠: 必ず「解決可能な参照」。permalink / URL / チケットID
export const ResolvableRef = z.object({
  kind: z.enum(["conversation", "issue", "pull_request", "ticket", "url", "document"]),
  ref: z.string().min(1).max(2000),
  quote: z.string().max(2000).optional(),
});
export const Evidence = z.array(ResolvableRef).max(10);

const TtlDays = z.number().int().min(1).max(3650);

// §5.1 の入力規則を型の層で守る
export const WriteMemory = z.object({
  id: z.string().uuid().optional(), // seed等の固定ID用。通常は省略
  type: MemoryType,
  scope: Scope,
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
  reason: z.string().max(5000).optional(),
  evidence: Evidence.default([]),
  supersedes: z.string().uuid().optional(),
  ttl_days: TtlDays.nullable().optional(),
  confirm: z.boolean().default(false),
  tags: z.array(z.string().max(50)).max(10).default([]),
}).superRefine((v, ctx) => {
  if (v.type === "decision") {
    if (v.evidence.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "type=decision は evidence が必須 (§5.1)" });
    }
    if (!v.reason || v.reason.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "type=decision は reason が必須 (§5.1)" });
    }
  }
  if (v.type === "constraint" && v.ttl_days != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ttl_days"], message: "type=constraint は TTL を持てない (§5.1: 制約は消えない)" });
  }
  if (v.type === "todo" && (v.ttl_days == null || v.ttl_days === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ttl_days"], message: "type=todo は ttl_days が必須 (§5.1: 未解決TODOは自然消滅)" });
  }
  if (v.supersedes && v.confirm) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirm"], message: "supersedes と confirm は排他 (§5.1)" });
  }
});
export type WriteMemoryInput = z.infer<typeof WriteMemory>;

export const SearchMemory = z.object({
  scope: Scope,
  q: z.string().min(1).max(2000),
  types: z.array(MemoryType).max(5).optional(),
  trust: z.array(z.enum(["verified", "provisional", "external"])).nonempty().default(["verified", "provisional"]),
  as_of: z.string().datetime().optional(), // ISO8601。監査再現用近似 (§5.2)
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchInput = z.infer<typeof SearchMemory>;

export const ContextQuery = z.object({
  scope: Scope,
  max_items: z.number().int().min(1).max(100).default(20),
});
export type ContextInput = z.infer<typeof ContextQuery>;

export const CorrectMemory = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(10000).optional(),
  reason: z.string().max(5000).nullable().optional(),
  evidence: Evidence.optional(),
  ttl_days: TtlDays.nullable().optional(),
  note: z.string().max(1000).optional(), // 訂正当の理由（snapshot に残る）
}).superRefine((v, ctx) => {
  if (v.title === undefined && v.content === undefined && v.evidence === undefined
      && v.reason === undefined && v.ttl_days === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "訂正文が空 (§5.1: speechless correct)" });
  }
});
export type CorrectInput = z.infer<typeof CorrectMemory>;

// ===== auth (src/lib/auth.ts) =====

export type Env = { Variables: { token: ApiTokenRow } };

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const RANK = { read: 1, write: 2, admin: 3 } as const;
export type RoleT = keyof typeof RANK;

async function authByHeader(c: Context<Env>): Promise<ApiTokenRow | null> {
  const h = c.req.header("authorization") ?? "";
  const secret = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!secret) return null;
  const [row] = await db.select().from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashToken(secret))).limit(1);
  return row ?? null;
}

export function requireRole(min: RoleT) {
  return createMiddleware<Env>(async (c, next) => {
    const row = await authByHeader(c);
    if (!row || RANK[row.role] < RANK[min]) {
      return c.json({ title: "unauthorized" }, 401);
    }
    c.set("token", row);
    await next();
  });
}
export const requireRead = requireRole("read");
export const requireWrite = requireRole("write");
export const requireAdmin = requireRole("admin");

// ===== ratelimit (src/lib/ratelimit.ts) =====

// 固定1時間窓。回数はDBに置く（§12.5）
export async function checkAndIncr(subject: string, limitPerHour: number) {
  const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const [row] = await db.select().from(ratelimits)
    .where(and(eq(ratelimits.subject, subject), eq(ratelimits.windowStart, windowStart)))
    .limit(1);
  const count = (row?.count ?? 0) + 1;
  await db.insert(ratelimits)
    .values({ subject, windowStart, count })
    .onConflictDoUpdate({
      target: [ratelimits.subject, ratelimits.windowStart],
      set: { count },
    });
  return { allowed: count <= limitPerHour, count };
}

// TODO: 古い窓の掃除は ttl-sweep に任せる（冪等なので積んでも壊れない）

// ===== embedding (src/lib/embedding.ts) =====

// 埋め込みはOpenAI互換 /embeddings への fetch のみ。モデル名はenvで固定（混在禁止, 仕様書 §3.5）
export interface EmbeddingResult { embedding: number[]; model: string }

export async function embed(text: string): Promise<EmbeddingResult> {
  const base = process.env.EMBEDDING_BASE_URL;
  const key = process.env.EMBEDDING_API_KEY;
  const model = process.env.EMBEDDING_MODEL;
  if (!base || !key || !model) {
    throw new Error("EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL が未設定");
  }
  const res = await fetch(base.replace(/\/+$/, "") + "/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model, input: text.slice(0, 30000) }),
  });
  if (!res.ok) {
    throw new Error("embedding failed: HTTP " + res.status);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  const embedding = json.data[0]?.embedding;
  if (!embedding) throw new Error("embedding failed: empty response");
  return { embedding, model };
}

// ===== guard (src/lib/guard.ts) =====

export interface SimilarCandidate {
  id: string;
  type: string;
  title: string;
  valid_from: string;
  similarity: number;
}

// 書込直前の近傍検査（§5.1: 類似0.85超は409差し戻し）
export async function similarActives(
  scope: { type: string; id: string },
  vec: number[],
  threshold: number,
  k = 5,
): Promise<SimilarCandidate[]> {
  const vecJson = JSON.stringify(vec);
  const rows = await db.execute(sql`
    SELECT id, type, title, valid_from,
           1 - (embedding <=> ${vecJson}::vector) AS similarity
    FROM memories
    WHERE status = 'active' AND embedding IS NOT NULL
      AND scope_type = ${scope.type}
      AND scope_id = ${scope.id}
    ORDER BY embedding <=> ${vecJson}::vector
    LIMIT ${k}`);
  return (rows as unknown as SimilarCandidate[])
    .filter((r) => Number(r.similarity) >= threshold)
    .map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

// ===== memories (src/lib/memories.ts) =====

export function simThreshold(): number {
  return Number(process.env.SIM_THRESHOLD ?? "0.85");
}

function snapshot(row: MemoryRow): object {
  return JSON.parse(JSON.stringify(row)) as object;
}

// API応答の姿（embedding は出さない, §5.1）
export function memView(row: MemoryRow) {
  return {
    id: row.id,
    type: row.type,
    scope: { type: row.scopeType, id: row.scopeId },
    title: row.title,
    content: row.content,
    reason: row.reason,
    evidence: row.evidence,
    trust: row.trust,
    status: row.status,
    supersedes: row.supersedes ?? null,
    tags: row.tags,
    valid_from: row.validFrom?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
    revision: row.revision,
    est_tokens: Math.ceil((row.title.length + row.content.length) / 2.2),
  };
}

// --- 書込: 埋め込み → 近傍検査 → tx で supersede+insert（§5.1/§12.4） ---
export async function createMemory(
  input: WriteMemoryInput,
  createdBy: string,
  trust: "verified" | "provisional" | "external" = "provisional",
): Promise<MemoryRow> {
  const { embedding, model } = await embed(input.title + "\n" + input.content);

  if (!input.confirm && !input.supersedes) {
    const candidates = await similarActives(input.scope, embedding, simThreshold());
    if (candidates.length > 0) {
      throw new ConflictError("similar-actives", candidates);
    }
  }

  const expiresAt = input.ttl_days
    ? new Date(Date.now() + input.ttl_days * 86400000)
    : null;

  return db.transaction(async (tx) => {
    if (input.supersedes) {
      const [old] = await tx.select().from(memories)
        .where(and(eq(memories.id, input.supersedes), eq(memories.status, "active")))
        .limit(1);
      if (!old) {
        throw new ConflictError("supersedes-target-not-active", [], "supersedes 対象が active でない");
      }
      await tx.update(memories)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(eq(memories.id, old.id));
      await tx.insert(memoryRevisions).values({
        memoryId: old.id,
        revision: old.revision,
        snapshot: snapshot(old),
        event: "supersede",
        changedBy: createdBy,
        changedAt: new Date(),
        note: "superseded by: " + input.title,
      });
    }

    const [row] = await tx.insert(memories).values({
      ...(input.id ? { id: input.id } : {}),
      type: input.type,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      title: input.title,
      content: input.content,
      reason: input.reason ?? null,
      evidence: input.evidence ?? [],
      embedding,
      embeddingModel: model,
      trust,
      supersedes: input.supersedes ?? null,
      tags: input.tags ?? [],
      expiresAt,
      createdBy,
    }).returning();
    return row;
  });
}

// --- 訂正: snapshot を残して revision+1（§3.2/§5.1） ---
export async function correctMemory(
  id: string,
  patch: CorrectInput,
  changedBy: string,
): Promise<MemoryRow> {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(memories)
      .where(and(eq(memories.id, id), eq(memories.status, "active"))).limit(1);
    if (!old) throw new ConflictError("target-not-active", [], "対象が active でない");

    await tx.insert(memoryRevisions).values({
      memoryId: old.id,
      revision: old.revision,
      snapshot: snapshot(old),
      event: "correct",
      changedBy,
      changedAt: new Date(),
      note: patch.note ?? null,
    });

    const nextEmbedding = patch.content
      ? await embed(old.title + "\n" + patch.content)
      : null;

    const [row] = await tx.update(memories).set({
      title: patch.title ?? old.title,
      content: patch.content ?? old.content,
      reason: patch.reason === undefined ? old.reason : patch.reason,
      evidence: patch.evidence ?? old.evidence,
      embedding: nextEmbedding?.embedding ?? old.embedding,
      embeddingModel: nextEmbedding?.model ?? old.embeddingModel,
      expiresAt: patch.ttl_days === undefined
        ? old.expiresAt
        : patch.ttl_days === null
          ? null
          : new Date(Date.now() + patch.ttl_days * 86400000),
      revision: old.revision + 1,
      updatedAt: new Date(),
    }).where(eq(memories.id, id)).returning();
    return row;
  });
}

// --- 削除: 論理削除 + snapshot（§3.2） ---
export async function deleteMemory(id: string, changedBy: string): Promise<MemoryRow> {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!old) throw new ConflictError("target-missing", [], "対象が無い");

    await tx.insert(memoryRevisions).values({
      memoryId: old.id,
      revision: old.revision,
      snapshot: snapshot(old),
      event: "delete",
      changedBy,
      changedAt: new Date(),
    });
    const [row] = await tx.update(memories)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(memories.id, id)).returning();
    return row;
  });
}

// --- 検索: semantic 近傍（§5.2） ---
export async function searchMemories(p: SearchInput) {
  const { embedding: vec, model } = await embed(p.q);
  const vecJson = JSON.stringify(vec);
  const conds = [
    eq(memories.status, "active"),
    isNotNull(memories.embedding),
    eq(memories.scopeType, p.scope.type),
    eq(memories.scopeId, p.scope.id),
    inArray(memories.trust, p.trust),
    p.types && p.types.length > 0 ? inArray(memories.type, p.types) : undefined,
    p.as_of ? lte(memories.validFrom, new Date(p.as_of)) : undefined,
  ].filter(Boolean);
  const rows = await db.select({
    id: memories.id,
    type: memories.type,
    title: memories.title,
    content: memories.content,
    reason: memories.reason,
    evidence: memories.evidence,
    trust: memories.trust,
    supersedes: memories.supersedes,
    validFrom: memories.validFrom,
    similarity: sql<number>`1 - (embedding <=> ${vecJson}::vector)`,
  }).from(memories)
    .where(and(...conds))
    .orderBy(sql`embedding <=> ${vecJson}::vector`)
    .limit(p.limit);
  return {
    matched_by: ["semantic"] as string[],
    model,
    results: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      content: r.content,
      reason: r.reason,
      evidence: r.evidence,
      trust: r.trust,
      supersedes: r.supersedes,
      valid_from: r.validFrom.toISOString(),
      similarity: Number(r.similarity),
    })),
  };
}

// --- 前提の要約（GET /memory/context, §5.2） ---
export async function buildContext(scope: { type: string; id: string }, maxItems: number) {
  const constraints = await db.select().from(memories)
    .where(and(eq(memories.status, "active"), eq(memories.type, "constraint"),
      eq(memories.scopeType, scope.type), eq(memories.scopeId, scope.id)));
  const decisions = await db.select().from(memories)
    .where(and(eq(memories.status, "active"), eq(memories.type, "decision"),
      eq(memories.scopeType, scope.type), eq(memories.scopeId, scope.id)))
    .orderBy(sql`valid_from DESC`).limit(maxItems);
  const chars = [...constraints, ...decisions]
    .reduce((n, r) => n + r.title.length + r.content.length, 0);
  return {
    scope,
    constraints: constraints.map(memView),
    decisions: decisions.map(memView),
    est_tokens: Math.ceil(chars / 2.2),
  };
}

// ===== GitHub issue bot (src/bots/github.ts) =====

// HMAC-SHA256 検証（GitHub webhook)
export function verifyGithubSignature(raw: string, sig: string | undefined): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!secret || !sig) return false;
  const mac = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from("sha256=" + mac);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

const TYPE_LABELS: Record<string, "decision" | "fact" | "constraint" | "preference" | "todo"> = {
  "type:decision": "decision",
  "type:fact": "fact",
  "type:constraint": "constraint",
  "type:preference": "preference",
  "type:todo": "todo",
};

interface GithubIssue {
  title?: string;
  body?: string | null;
  html_url?: string;
  url?: string;          // API URL
  labels?: Array<{ name: string } | string>;
  user?: { login?: string };
}

// issue本文から "### 見出し" 直下を取り出す（issueフォームの欄に対応）
function section(body: string, heading: string): string {
  const re = new RegExp("###\\s*" + heading + "\\s*\\n([\\s\\S]*?)(?=\\n###|$)");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

export async function handleGithubIssue(payload: unknown): Promise<{ ok: boolean; skipped?: string; memory?: unknown; conflict?: unknown }> {
  const p = payload as { action?: string; issue?: GithubIssue; repository?: { name?: string } };
  const issue = p.issue;
  if (!issue) return { ok: false, skipped: "not an issue event" };
  if (p.action !== "opened" && p.action !== "edited") {
    return { ok: false, skipped: "action not handled: " + String(p.action) };
  }
  const labels: string[] = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  if (!labels.includes("memory")) return { ok: false, skipped: "no memory label" };

  const type = labels.map((n) => TYPE_LABELS[n]).find(Boolean);
  if (!type) return { ok: false, skipped: "no type:* label" };

  const body = String(issue.body ?? "");
  const content = section(body, "内容") || body;
  const reason = section(body, "理由") || undefined;
  const evidenceUrl = (body.match(/https?:\/\/\S+/) ?? [])[0];

  const ttlLabel = labels.find((n) => n.startsWith("ttl:"));
  const ttlDays = ttlLabel ? Number(ttlLabel.split(":")[1]) : (type === "todo" ? 14 : null);

  const scope = {
    type: process.env.DEFAULT_SCOPE_TYPE ?? "project",
    id: process.env.DEFAULT_SCOPE_ID ?? p.repository?.name ?? "memory_api",
  };

  const evidence = [
    { kind: "issue", ref: issue.html_url ?? "about:blank", quote: body.slice(0, 2000) },
    ...(evidenceUrl ? [{ kind: "document", ref: evidenceUrl }] : []),
  ];

  const input = {
    type,
    scope,
    title: issue.title ?? "(untitled)",
    content,
    ...(reason ? { reason } : {}),
    evidence,
    ttl_days: ttlDays as number | null,
    tags: labels.filter((n) => n !== "memory" && !n.startsWith("type:")),
  };
  const parsed = WriteMemory.safeParse(input);
  if (!parsed.success) return { ok: false, skipped: "invalid input: " + String(parsed.error.issues[0]?.message) };

  try {
    const row = await createMemory(parsed.data, "github:" + (issue.user?.login ?? "unknown"));
    return { ok: true, memory: { id: row.id, title: row.title } };
  } catch (e) {
    if (e instanceof ConflictError) {
      await addLabel(issue, "memory:conflict");
      return { ok: true, conflict: e.candidates };
    }
    throw e;
  }
}

async function addLabel(issue: GithubIssue, name: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !issue.url) return;
  await fetch(issue.url + "/labels", {
    method: "POST",
    headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json" },
    body: JSON.stringify({ labels: [name] }),
  }).catch(() => {});
}

// ===== Slack /why bot (src/bots/slack.ts) =====

// Slack 署名検証（v0=HMAC-SHA256(signingSecret, "v0:ts:body"))
export function verifySlackSignature(raw: string, sig: string | undefined, ts: string | undefined): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET ?? "";
  if (!secret || !sig || !ts) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mac = createHmac("sha256", secret).update("v0:" + ts + ":" + raw).digest("hex");
  const a = Buffer.from("v0=" + mac);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleSlack(raw: string) {
  const params = new URLSearchParams(raw);
  const text = (params.get("text") ?? "").trim();
  if (!text) {
    return { response_type: "ephemeral", text: "使い方: /why <質問>  （例: /why なぜこの構成なのか）" };
  }
  const scope = {
    type: process.env.DEFAULT_SCOPE_TYPE ?? "project",
    id: process.env.DEFAULT_SCOPE_ID ?? "memory_api",
  };
  const parsed = SearchMemory.safeParse({ scope, q: text, limit: 3 });
  if (!parsed.success) return { response_type: "ephemeral", text: "検索クエリが不正です" };

  try {
    const res = await searchMemories(parsed.data);
    await db.insert(referenceLogs).values({
      kind: "search", subject: "slack", scopeType: scope.type, scopeId: scope.id,
      query: text, resultCount: res.results.length,
    }).catch(() => {});
    if (res.results.length === 0) {
      return { response_type: "ephemeral", text: "該当する記憶は見つかりません: " + text };
    }
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "*" + text + "* の記憶（" + res.results.length + "件）" } },
      ...res.results.map((r) => {
        const url = (r.evidence as Array<{ ref?: string }> | null)?.[0]?.ref;
        const title = url ? "<" + url + "|" + r.title + ">" : r.title;
        const body = r.content.length > 280 ? r.content.slice(0, 280) + "…" : r.content;
        return {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "• *" + title + "*（" + r.type + " / 類似度 " + r.similarity.toFixed(3) + "）\n" + body,
          },
        };
      }),
    ];
    return { response_type: "in_channel", blocks };
  } catch (e) {
    return { response_type: "ephemeral", text: "検索に失敗しました: " + String(e) };
  }
}

// ===== crons (src/cron/ttl-sweep.ts, src/cron/audit-export.ts) =====

// 忘却: 期限を過ぎたactive記憶を expired へ（§3.4/§12.4。WHERE句で二重sweep防止=冪等）
export async function ttlSweep(): Promise<number> {
  const now = new Date();
  const victims = await db.select().from(memories)
    .where(and(eq(memories.status, "active"), isNotNull(memories.expiresAt), lt(memories.expiresAt, now)));
  if (victims.length === 0) return 0;
  await db.transaction(async (tx) => {
    for (const row of victims) {
      await tx.insert(memoryRevisions).values({
        memoryId: row.id,
        revision: row.revision,
        snapshot: JSON.parse(JSON.stringify(row)) as object,
        event: "expire",
        changedBy: "cron:ttl-sweep",
        changedAt: now,
      });
      await tx.update(memories)
        .set({ status: "expired", updatedAt: now })
        .where(eq(memories.id, row.id));
    }
  });
  return victims.length;
}

// 監査: 直近25時間の revision 履歴を吐き出す。journalctl へ
// （窓を25hにして多重実行に強くしている）
export async function auditExport(): Promise<number> {
  const since = new Date(Date.now() - 25 * 3600000);
  const rows = await db.select().from(memoryRevisions)
    .where(gte(memoryRevisions.changedAt, since));
  for (const r of rows) {
    console.log(JSON.stringify({
      memoryId: r.memoryId,
      revision: r.revision,
      event: r.event,
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
    }));
  }
  return rows.length;
}

// ===== routes (src/api/app.ts) =====

export const app = new Hono<Env>();

function problem(c: any, status: number, type: string, detail?: unknown) {
  return c.json({
    type: "https://memory.example/errors/" + type,
    title: type,
    status,
    detail: detail ?? null,
  }, status);
}

function conflictOrError(c: any, e: unknown) {
  if (e instanceof ConflictError) {
    return c.json({
      type: "https://memory.example/errors/similar-memories",
      title: "similar memories exist",
      status: 409,
      detail: "近い記憶が既に存在する。supersedes か confirm を使うか、内容を変えて再提出せよ (§5.1)",
      subtype: e.subtype,
      candidates: e.candidates,
    }, 409);
  }
  if (e instanceof ApiError) return problem(c, e.status, e.type, String(e.message));
  console.error("unhandled:", e);
  return problem(c, 500, "internal");
}

// 参照ログ（会計層の種）。応答を遅らせないよう waitUntil に載せる
function reflog(c: any, kind: string, subject: string, scopeType: string, scopeId: string, query: string | null, resultCount: number) {
  const p = db.insert(referenceLogs).values({
    kind, subject, scopeType, scopeId, query, resultCount,
  }).then(() => {}, () => {});
  try { c.executionCtx.waitUntil(p); } catch { /* waitUntil の無い環境では握り潰す */ }
}

// --- 基礎 ---
app.get("/healthz", async (c) => {
  await db.execute(sql`SELECT 1`);
  return c.json({ status: "ok" });
});

// --- 診断: env変数の「有無」だけ返す(値は返さない)。検収が済んだら削る ---


app.onError((e, c) => conflictOrError(c, c.error ?? e));

// --- 書込（§5.1: 409摩擦 / 冪等 / レート制限） ---
app.post("/memory", requireWrite, async (c) => {
  const token = c.get("token");
  const idem = c.req.header("idempotency-key");
  if (idem) {
    const [cached] = await db.select().from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idem)).limit(1);
    if (cached) return c.json(cached.response, 201);
  }
  const parsed = WriteMemory.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  const rate = await checkAndIncr(token.name, Number(process.env.RATE_LIMIT_PER_HOUR ?? "60"));
  if (!rate.allowed) return problem(c, 429, "rate-limit", "write rate exceeded");

  try {
    const row = await createMemory(parsed.data, "token:" + token.name);
    if (idem) await db.insert(idempotencyKeys).values({ key: idem, response: memView(row) });
    reflog(c, "write", token.name, row.scopeType, row.scopeId, parsed.data.title, 1);
    return c.json(memView(row), 201);
  } catch (e) {
    return conflictOrError(c, e);
  }
});

// --- 検索（§5.2） ---
app.post("/memory/search", requireRead, async (c) => {
  const token = c.get("token");
  const parsed = SearchMemory.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  const result = await searchMemories(parsed.data);
  reflog(c, "search", token.name, parsed.data.scope.type, parsed.data.scope.id, parsed.data.q, result.results.length);
  return c.json(result);
});

// --- 前提の要約（§5.2） ---
app.get("/memory/context", requireRead, async (c) => {
  const token = c.get("token");
  const parsed = ContextQuery.safeParse({
    scope: {
      type: c.req.query("scope_type") ?? process.env.DEFAULT_SCOPE_TYPE ?? "project",
      id: c.req.query("scope_id") ?? process.env.DEFAULT_SCOPE_ID ?? "memory_api",
    },
    max_items: Number(c.req.query("max_items") ?? 20),
  });
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  const ctx = await buildContext(parsed.data.scope, parsed.data.max_items);
  reflog(c, "context", token.name, parsed.data.scope.type, parsed.data.scope.id, null,
    ctx.constraints.length + ctx.decisions.length);
  return c.json(ctx);
});

app.get("/memory/:id", requireRead, async (c) => {
  const [row] = await db.select().from(memories)
    .where(eq(memories.id, c.req.param("id"))).limit(1);
  if (!row) return problem(c, 404, "not-found");
  return c.json(memView(row));
});

// --- 訂正（§3.2: snapshotを残す） ---
app.patch("/memory/:id", requireWrite, async (c) => {
  const token = c.get("token");
  const parsed = CorrectMemory.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  try {
    const row = await correctMemory(c.req.param("id"), parsed.data, "token:" + token.name);
    return c.json(memView(row));
  } catch (e) {
    return conflictOrError(c, e);
  }
});

// --- 削除: admin=人間のみ（§5.1 権限3分離） ---
app.delete("/memory/:id", requireAdmin, async (c) => {
  const token = c.get("token");
  try {
    await deleteMemory(c.req.param("id"), "token:" + token.name);
    return c.body(null, 204);
  } catch (e) {
    return conflictOrError(c, e);
  }
});

// --- cron（systemd timer 等は GET で叩く; Authorization: Bearer CRON_SECRET） ---
const cronGuard = createMiddleware<Env>(async (c, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || c.req.header("authorization") !== "Bearer " + secret) {
    return c.json({ title: "unauthorized" }, 401);
  }
  await next();
});
app.get("/cron/ttl-sweep", cronGuard, async (c) => c.json({ expired: await ttlSweep() }));
app.post("/cron/ttl-sweep", cronGuard, async (c) => c.json({ expired: await ttlSweep() }));
app.get("/cron/audit-export", cronGuard, async (c) => c.json({ exported: await auditExport() }));
app.post("/cron/audit-export", cronGuard, async (c) => c.json({ exported: await auditExport() }));

// --- 書き口: GitHub issue → 記憶（同期bot, §4） ---
app.post("/hooks/github", async (c) => {
  const raw = await c.req.raw.clone().text();
  if (!verifyGithubSignature(raw, c.req.header("x-hub-signature-256"))) {
    return c.json({ title: "unauthorized" }, 401);
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return c.json({ title: "bad payload" }, 400); }
  const out = await handleGithubIssue(payload).catch((e) => ({ ok: false, error: String(e) }));
  return c.json(out);
});

// --- 人間の読み口: Slack /why（§4） ---
app.post("/hooks/slack", async (c) => {
  const raw = await c.req.raw.clone().text();
  if (!verifySlackSignature(raw, c.req.header("x-slack-signature"), c.req.header("x-slack-request-timestamp"))) {
    return c.json({ title: "unauthorized" }, 401);
  }
  return c.json(await handleSlack(raw));
});

// ===== dual-contract handler (src/entry.ts + 正規化) =====
//
// dual-contract:
//  - web-standard Request が来ればそのまま app へ。
//    逆プロキシ等から legacy (req, res) で渡されても応える。
//  - /api/* prefix が付いた path は剥ぐ正規化だけ行う。
//    どちらの呼び出し方でも同一の routing に落ちる。

function stripApiPrefix(pathname: string): string {
  if (pathname === "/api") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice("/api".length);
  return pathname;
}

function reqUrl(req: any): URL {
  const host = typeof req.headers?.get === "function"
    ? req.headers.get("host") ?? "localhost"
    : String(req.headers?.host ?? "localhost");
  return new URL(String(req.url || "/"), "https://" + host);
}

async function readBody(req: any): Promise<Buffer | undefined> {
  const method = String(req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  if (typeof req?.arrayBuffer === "function") return Buffer.from(await req.arrayBuffer());
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function handleWeb(request: Request): Promise<Response> {
  try {
    const u = new URL(request.url);
    const stripped = stripApiPrefix(u.pathname);
    if (stripped === u.pathname) return await app.fetch(request);
    // /api/* 直呼びの正規化: query・headers・body は保全する
    const target = new URL(stripped + u.search, u.origin);
    const method = request.method.toUpperCase();
    const init: RequestInit = { method, headers: request.headers };
    if (method !== "GET" && method !== "HEAD" && request.body) {
      init.body = request.body;
      // @ts-ignore duplex は undici のオプション
      init.duplex = "half";
    }
    return await app.fetch(new Request(target, init));
  } catch (e) {
    return Response.json(
      { type: "https://memory.example/errors/internal", title: "internal", detail: String(e) },
      { status: 500 },
    );
  }
}

export default async function handler(req: any, res: any): Promise<Response | void> {
  const isWeb = typeof req?.arrayBuffer === "function" && typeof res?.end !== "function";
  if (isWeb) return handleWeb(req as unknown as Request);

  // legacy (IncomingMessage, ServerResponse)
  const url = reqUrl(req);
  const headers = new Headers();
  const raw = req.headers ?? {};
  for (const [k, v] of Object.entries(raw)) {
    if (["host", "connection", "content-length", "transfer-encoding"].includes(k)) continue;
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
  }
  const method = String(req.method ?? "GET").toUpperCase();
  const body = await readBody(req);
  const [pathname, search] = String(req.url || "/").split("?");
  const target = new URL(stripApiPrefix(pathname) + (search ? "?" + search : ""), url.origin);
  let request: Request;
  if (body !== undefined) {
    // @ts-ignore duplex は undici のオプション
    request = new Request(target, { method, headers, body, duplex: "half" });
  } else {
    request = new Request(target, { method, headers });
  }

  const response = await handleWeb(request);
  res.statusCode = response.status;
  response.headers.forEach((v, k) => {
    if (k.toLowerCase() === "content-encoding") return;
    res.setHeader(k, v);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

export const config = { runtime: "nodejs" };
