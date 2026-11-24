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
//

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
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

// pgvector。次元は vector(N) の N に採用モデルの実測次元を当てる (現状は 1536 の仮置き。
// probe 実測で確定して直す)。値はJSの数値配列、ドライバにはJSON文字列 "[1,2,...]" を渡す
export const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() { return "vector(1536)"; },
  toDriver(value: number[]) { return JSON.stringify(value); },
  fromDriver(value: string): number[] { return JSON.parse(value); },
});

export type EvidenceItem = { kind: string; ref: string; quote?: string }

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
const makeDb = () => {
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
// type別の業務規則 (§5.1)。WriteMemoryのsuperRefineとcorrectMemoryの再適用
// (M03 2026-11-23) が同じ規則を見るための一元化点。PATCHで本体の姿を
// 破損させないための鍵。戻り値は違反メッセージの配列 (空なら健全)。
export const typeRuleIssues = (v: {
  type: string;
  ttl_days?: number | null | undefined;
  reason?: string | null | undefined;
  evidence: EvidenceItem[];
}): string[] => {
  const issues: string[] = [];
  if (v.type === "decision") {
    if (v.evidence.length === 0) {
      issues.push("type=decision は evidence が必須 (§5.1)");
    }
    if (v.reason == null || v.reason.trim() === "") {
      issues.push("type=decision は reason が必須 (§5.1)");
    }
  }
  if (v.type === "constraint" && v.ttl_days != null) {
    issues.push("type=constraint は TTL を持てない (§5.1: 制約は消えない)");
  }
  if (v.type === "todo" && v.ttl_days == null) {
    issues.push("type=todo は ttl_days が必須 (§5.1: 未解決TODOは自然消滅)");
  }
  return issues;
}

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
  dry_run: z.boolean().default(false), // 予行演習 (#5, M05): 保存せずに衝突だけ見る
  tags: z.array(z.string().max(50)).max(10).default([]),
}).superRefine((v, ctx) => {
  for (const msg of typeRuleIssues(v)) {
    const path = msg.includes("evidence") ? "evidence" : msg.includes("reason") ? "reason" : "ttl_days";
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: msg });
  }
  if (v.supersedes && v.confirm) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirm"], message: "supersedes と confirm は排他 (§5.1)" });
  }
});
export type WriteMemoryInput = z.infer<typeof WriteMemory>;

// M7 (2026-11-24 報告書): as_of の暦妥当性。new Date() は 2026-02-30 を
// 3/2 に正規化してしまうので、成分で実在を検査する。
export const isValidIsoTimestamp = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/u.exec(s);
  if (!m) return false;
  const [year, month, day, hour, minute, second] =
    [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59;
};

export const SearchMemory = z.object({
  scope: Scope,
  q: z.string().min(1).max(2000),
  types: z.array(MemoryType).max(5).optional(),
  trust: z.array(z.enum(["verified", "provisional", "external"])).nonempty().default(["verified", "provisional"]),
  // ISO8601。監査再現用近似 (§5.2)。M7 (第1報, 2026-11-24): 暦の実在まで
  // 検査する。形だけだと 2026-02-30 が 3/2 にずれて静かに検索され、
  // 2026-13-01 は Invalid Date で 500 になる (旧 zod .datetime() は両方400)。
  as_of: z.string().datetime()
    .refine(isValidIsoTimestamp, "calendar-invalid (not a real UTC datetime)")
    .optional(),
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

// 一覧 (#3, M05): scope/type/status で絞り込み、limit/offset でページ送り。
export const ListQuery = z.object({
  scope_type: z.enum(["project", "user"]).optional(),
  scope_id: z.string().min(1).max(100).optional(),
  type: MemoryType.optional(),
  status: z.enum(["active", "superseded", "expired", "deleted"]).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
});
export type ListInput = z.infer<typeof ListQuery>;

// 履歴 (#1, M05): append-only の行を新しいイベント順 (DESC) で読む。
export const HistoryQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(10000).default(0),
});
export type HistoryInput = z.infer<typeof HistoryQuery>;

// 復活 (#2, M05): 戻した理由を note として履歴に残せる (任意)。
export const RestoreInput = z.object({
  note: z.string().max(1000).optional(),
});
export type RestoreNoteT = z.infer<typeof RestoreInput>;

// parseBody: safeParse の薄包装。L9 (第1報) の新契約で 400 の detail は
// zod の素の issue ではなく {path, message}[] に整えて返す。
export const parseBody = <S extends z.ZodType>(schema: S) =>
  (input: unknown):
    | { success: true; data: z.infer<S> }
    | { success: false; error: { issues: Array<{ path: string; message: string }> } } => {
    const r = schema.safeParse(input);
    return r.success
      ? { success: true, data: r.data }
      : {
          success: false,
          error: {
            issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        };
  }

// ===== auth (src/lib/auth.ts) =====

export type Env = { Variables: { token: ApiTokenRow } };

export const hashToken = (secret: string): string => {
  return createHash("sha256").update(secret).digest("hex");
}

// L14 (改訂4, 2026-11-24): シークレット類の文字列比較は定数時間で行う。
// 素の === は最初の不一致文字で抜けるので、正解の先頭部分から時間差で
// 情報が洩れる。長さ差も比較時間に現れないよう SHA-256 を通してから
// timingSafeEqual に掛ける (長さが揃うので crash も起きない)。
export const safeEqual = (a: string, b: string): boolean => {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const RANK = { read: 1, write: 2, admin: 3 } as const;
export type RoleT = keyof typeof RANK;

const authByHeader = async (c: Context<Env>): Promise<ApiTokenRow | null> => {
  const h = c.req.header("authorization") ?? "";
  const secret = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!secret) return null;
  const [row] = await db.select().from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashToken(secret))).limit(1);
  return row ?? null;
}

export const requireRole = (min: RoleT) => {
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
export const checkAndIncr = async (subject: string, limitPerHour: number) => {
  const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  // H2 (問題報告書第1報, 2026-11-24): 読み→書きの2段階を1文のアップサートに
  // 集約。2段階だと並走が同じ count を読んで両方 +1 を書き、制限をすり抜ける。
  // RETURNING で挙上後の実値を受け取り、その実値で判定する。
  const [row] = await db.insert(ratelimits)
    .values({ subject, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [ratelimits.subject, ratelimits.windowStart],
      set: { count: sql`${ratelimits.count} + 1` },
    })
    .returning({ count: ratelimits.count });
  const count = row?.count ?? 1;
  return { allowed: count <= limitPerHour, count };
}

// 古い窓の掃除は ttl-sweep が担う (N-1, 2026-11-23 実装済み)

// ===== embedding (src/lib/embedding.ts) =====

// 埋め込みはOpenAI互換 /embeddings への fetch のみ。モデル名はenvで固定（混在禁止, 仕様書 §3.5）
export type EmbeddingResult = { embedding: number[]; model: string }

export const embed = async (text: string): Promise<EmbeddingResult> => {
  const base = process.env.EMBEDDING_BASE_URL;
  const key = process.env.EMBEDDING_API_KEY;
  const model = process.env.EMBEDDING_MODEL;
  if (!base || !key || !model) {
    throw new Error("EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL が未設定");
  }
  // N-6, 2026-11-23: さくら常駐でも必ず返る窓。既定15秒、envで延長可。
  const res = await fetch(base.replace(/\/+$/, "") + "/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model, input: text.slice(0, 30000) }),
    signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS ?? "15000")),
  });
  if (!res.ok) {
    throw new Error("embedding failed: HTTP " + res.status);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  const embedding = json.data[0]?.embedding;
  if (!embedding) throw new Error("embedding failed: empty response");
  return { embedding, model };
}

// L15 (改訂4, 2026-11-24): 旧実装は 5xx 全部 (過負荷で 429 と 5xx が併発する
// 5xx も併発させる場面を含む) と全 TypeError (コードのバグも混ざる) を
// 再試行し、負荷を隠して伸ばしていた。再試行は HTTP 503 とネットワーク系
// (undici の "fetch failed" 系 TypeError) だけに限り、待ちは 500ms にする。
// タイムアウト (N-6) は再試行の対象にしないので N-6 検査はそのまま reject する。
const transientEmbedFailure = (cause: unknown): boolean =>
  (cause instanceof TypeError && /fetch/i.test(cause.message))
  || (cause instanceof Error && /HTTP 503\b/.test(cause.message));

const sleepMs = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

const embedWithRetry = async (text: string): Promise<EmbeddingResult> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await embed(text);
    } catch (e) {
      if (attempt >= 2 || !transientEmbedFailure(e)) throw e;
      await sleepMs(500);
    }
  }
}

// ===== guard (src/lib/guard.ts) =====

export type SimilarCandidate = {
  id: string;
  type: string;
  title: string;
  valid_from: string;
  similarity: number;
}

// 近傍索引の探索窓 (M05, 2026-11-23 実測): pgvector の HNSW 索引は
// WHERE フィルタを無視して「全体での近傍 ef_search 件」しか返さないため、
// スコープ絞り込み対象の行が索引の近傍圏外だと 0 件に化す (CI 実測: 質問
// ベクトルがランダム方向だと漏れる)。pgvector 0.8+ の iterative scan は
// フィルタを通過する行が揃うまで探索を継続するので、ここを全近傍参照の
// 前段に置く。未対応バージョンでは設定を諦めて従来の近似に戻す。
// SET LOCAL なので効果は tx 内に閉じ、接続プールに設定は残さない。
const vectorScanOn = async <T>(d: DbT, fn: (tx: TxT) => Promise<T>): Promise<T> => {
  return d.transaction(async (tx) => {
    try {
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`);
    } catch { /* pgvector < 0.8: GUC が無い。近似のまま諦める */ }
    return fn(tx);
  });
}

// 書込直前の近傍検査（§5.1: 類似0.85超は409差し戻し）。
// excludeId は訂正時の自分自身の除外に使う (M03)。
export const similarActivesOn = async (
  d: DbT,
  scope: { type: string; id: string },
  vec: number[],
  threshold: number,
  k = 5,
  excludeId?: string,
): Promise<SimilarCandidate[]> => {
  const vecJson = JSON.stringify(vec);
  const excludeSql = excludeId ? sql` AND id <> ${excludeId}::uuid` : sql``;
  const rows = await vectorScanOn(d, (tx) => tx.execute(sql`
    SELECT id, type, title, valid_from,
           1 - (embedding <=> ${vecJson}::vector) AS similarity
    FROM memories
    WHERE status = 'active' AND embedding IS NOT NULL
      AND scope_type = ${scope.type}
      AND scope_id = ${scope.id}${excludeSql}
    ORDER BY embedding <=> ${vecJson}::vector
    LIMIT ${k}`));
  return (rows as unknown as SimilarCandidate[])
    .filter((r) => Number(r.similarity) >= threshold)
    .map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

// 互換ラッパ: 既定の db で問う (旧呼び出し契約を変えない)。
export const similarActives = (
  scope: { type: string; id: string },
  vec: number[],
  threshold: number,
  k = 5,
  excludeId?: string,
): Promise<SimilarCandidate[]> => similarActivesOn(db, scope, vec, threshold, k, excludeId);

// ===== memories (src/lib/memories.ts) =====

export const simThreshold = (): number => {
  return Number(process.env.SIM_THRESHOLD ?? "0.85");
}

const snapshot = (row: MemoryRow): object => {
  return JSON.parse(JSON.stringify(row)) as object;
}

// --- 状態遷移とリビジョン採番の一元管理 (#33/#34, M02 2026-11-23) ---
// 変更系の全関数 (correct/supersede/expire/delete) は必ずここを通る。
// 遷移できるかどうかはこの表だけが正 (一元化 #33)。
export type MemoryStatusT = (typeof memoryStatus.enumValues)[number];

// イベント → そのイベントを起こしてよい開始ステータス
export const EVENT_SOURCES: Record<string, readonly MemoryStatusT[]> = {
  // 訂正と置換は生きている記憶 (active) にだけ
  correct:   ["active"],
  supersede: ["active"],
  expire:    ["active"],
  // 削除は人間 (admin) の最終手段。生きていた証拠 (snapshot) を残して冥送。
  delete:    ["active", "superseded", "expired"],
  // 復活 (#2, M05): 誤った削除・置換・期限切れを人間 (admin) が巻き戻す。
  restore:   ["superseded", "expired", "deleted"],
};

export const assertEvent = (current: MemoryStatusT, event: string): void => {
  const ok = EVENT_SOURCES[event];
  if (!ok) throw new Error("unknown event: " + event);
  if (!ok.includes(current)) {
    throw new ConflictError(
      "invalid-transition", [],
      `event=${event} は status=${current} からは不許可 (許可: ${ok.join(", ")})`,
    );
  }
}

type DbT = ReturnType<typeof makeDb>;
type TxT = Parameters<Parameters<DbT["transaction"]>[0]>[0];

// M12 (改訂4, 2026-11-24): 書込み系 tx の先頭で SET LOCAL statement_timeout を
// 置き、DB 側にも天井 (DB_TIMEOUT_MS) を効かせる。遮断で諦めた tx が DB 側で
// は commit される (あるいは接続を握ったまま残る) 窓を消す。SET LOCAL は
// この tx に閉じ、プールへ返した接続には残らない。SET の失敗は tx を
// 「中断状態」にするので SAVEPOINT で囲み、失敗時は天井無しに諦める。
const dbTimeoutMs = (): number => Number(process.env.DB_TIMEOUT_MS ?? "15000");

const writeTx = async <T>(d: DbT, fn: (tx: TxT) => Promise<T>): Promise<T> => {
  return d.transaction(async (tx) => {
    const ms = dbTimeoutMs();
    if (Number.isFinite(ms) && ms > 0) {
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql.raw("SET LOCAL statement_timeout = " + Math.floor(ms)));
        });
      } catch { /* GUC が効かない環境: 天井無しに諦める */ }
    }
    return fn(tx);
  });
};

// 履歴採番 (#34): 行番号は「その記憶のこれまでの最大revision+1」へ統一。
// 旧実装は行番号に「イベント時点の本体revision」を使っていたため、本体の
// revisionを進めないイベント (supersede/expire/delete) が同じ記憶に続くと
// 主キー (memory_id, revision) が衝突 (23505) して DELETE が 500 になっていた
// (2026-11-23 バグ1)。これでどの経路でも衝突しない連番になる。
// 本体は常に採番結果に合わせる。createが仮想イベント1なので、
// 新規記憶では「本体revision = 履歴行数 + 1」が以後ずっと成り立つ。
const nextRevision = async (tx: TxT, id: string, currentRevision: number): Promise<number> => {
  const res = await tx.execute(sql`
    SELECT COALESCE(MAX(revision), 0) AS maxrev
    FROM memory_revisions WHERE memory_id = ${id}`);
  const maxRev = Number((res as unknown as Array<{ maxrev: number | string }>)[0]?.maxrev ?? 0);
  return Math.max(maxRev, currentRevision) + 1;
}

// API応答の姿（embedding は出さない, §5.1）
export const memView = (row: MemoryRow) => {
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

// H3 (第1報, 2026-11-24): 冪等キーが既に使われていた時の「再応答」例外。
// createMemory の tx 内で throw されるので記憶の作成は巻き戻り、
// route が保存済みの応答で 201 を返す。
export class IdemReplay {
  constructor(public response: unknown) {}
}

// --- 書込: 埋め込み → 近傍検査 → tx で supersede+insert（§5.1/§12.4） ---
export const createMemory = async (
  input: WriteMemoryInput,
  createdBy: string,
  trust: "verified" | "provisional" | "external" = "provisional",
  idempotencyKey?: string,
): Promise<MemoryRow> => {
  // N-5, 2026-11-23: 明示id指定の重複は類似ガードより先に返す。
  // 同一内容の再送は先に similar-actives に当たって表向きの種が変わるため、
  // id指定のある再送は id の衝突として告知する。埋め込み前に検査すれば
  // 無駄な embedding 呼び出しも省ける。tx 内にも並走背後の窓を残す。
  if (input.id) {
    const [dup] = await db.select({ id: memories.id }).from(memories)
      .where(eq(memories.id, input.id)).limit(1);
    if (dup) {
      throw new ConflictError("duplicate-id", [], "指定された id は既に存在する");
    }
  }

  // M6 (第1報, 2026-11-24): 置換対象は書込先と同じ scope に限る。別 scope の
  // 記憶を勝手に superseded にできる穴なので、埋め込みの前段で先に落とす。
  if (input.supersedes) {
    const [target] = await db
      .select({ id: memories.id, scopeType: memories.scopeType, scopeId: memories.scopeId, title: memories.title })
      .from(memories)
      .where(and(eq(memories.id, input.supersedes), eq(memories.status, "active")))
      .limit(1);
    if (!target) {
      throw new ConflictError("supersedes-target-not-active", [], "supersedes 対象が active でない");
    }
    if (target.scopeType !== input.scope.type || target.scopeId !== input.scope.id) {
      throw new ConflictError("supersedes-scope-mismatch", [target], "supersedes 対象が別 scope に属する");
    }
  }

  const { embedding, model } = await embedWithRetry(input.title + "\n" + input.content);

  if (!input.confirm && !input.supersedes) {
    const candidates = await similarActives(input.scope, embedding, simThreshold());
    if (candidates.length > 0) {
      throw new ConflictError("similar-actives", candidates);
    }
  }

  // 時刻はここで1点だけ取る (移行前の Date.now() 相当を変えない)。
  const now = new Date();
  const expiresAt = input.ttl_days
    ? new Date(now.getTime() + input.ttl_days * 86400000)
    : null;

  return writeTx(db, async (tx) => {
    // N-5, 2026-11-23: 並走で前段検査を抜けた場合の背後の窓。ここでも
    // 一意制約違反 (23505) が素の500にならないように検査して 409 を返す。
    if (input.id) {
      const [dup] = await tx.select({ id: memories.id }).from(memories)
        .where(eq(memories.id, input.id)).limit(1);
      if (dup) {
        throw new ConflictError("duplicate-id", [], "指定された id は既に存在する");
      }
    }
    if (input.supersedes) {
      const [old] = await tx.select().from(memories)
        .where(and(eq(memories.id, input.supersedes), eq(memories.status, "active")))
        .limit(1)
        .for("update");
      if (!old) {
        throw new ConflictError("supersedes-target-not-active", [], "supersedes 対象が active でない");
      }
      // M6 (第1報, 2026-11-24): 並走で前段を抜けた窓。tx 内でも同じ検査。
      if (old.scopeType !== input.scope.type || old.scopeId !== input.scope.id) {
        throw new ConflictError("supersedes-scope-mismatch", [old], "supersedes 対象が別 scope に属する");
      }
      assertEvent(old.status, "supersede");
      const rev = await nextRevision(tx, old.id, old.revision);
      await tx.update(memories)
        .set({ status: "superseded", revision: rev, updatedAt: now })
        .where(eq(memories.id, old.id));
      await tx.insert(memoryRevisions).values({
        memoryId: old.id,
        revision: rev,
        snapshot: snapshot(old),
        event: "supersede",
        changedBy: createdBy,
        changedAt: now,
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
      tags: [...(input.tags ?? [])],
      expiresAt,
      createdBy,
    }).returning();
    // H3 (第1報, 2026-11-24): 冪等キーの保存を記憶作成と同じ tx に置く。
    // 旧実装は create の外で insert していたので、作成は失敗したのに
    // キーだけ残った (同じキーが二度と使えない事故) り、並走が同キーで
    // 二重作成できた。ON CONFLICT DO NOTHING で先着を掴めなければ
    // tx を巻き戻し、保存済み応答で 201 を返す (dry_run はキー不消費)。
    if (idempotencyKey) {
      const [claimed] = await tx.insert(idempotencyKeys)
        .values({ key: idempotencyKey, response: memView(row) })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (!claimed) {
        const [prev] = await tx.select().from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, idempotencyKey)).limit(1);
        throw new IdemReplay(prev?.response ?? null);
      }
    }
    return row;
  });
}

// --- 訂正: snapshot を残して revision+1（§3.2/§5.1） ---
// M03 (2026-11-23): 訂正後の本体の姿に書込ルールを再適用する。
// 旧実装は (a) 類似ガードを素通り、(b) titleだけの変更で再埋め込みしない、
// (c) 制約にTTLを付けられる、(d) 決定からevidence/reasonを抜ける、の4点が
// PATCH経由で破れる道だった。以後マージ後の姿が全規則を通ってから書く。
export const correctMemory = async (
  id: string,
  patch: CorrectInput,
  changedBy: string,
  dbx: DbT = db,
): Promise<MemoryRow> => {
  // 時刻はここで1点だけ取る (ttl再計算・snapshot・updatedAtの基準)。
  const now = new Date();

  // まず現状を読んでマージ後の姿を確定する (ガードはtx外で先に済ませる)
  const [old] = await dbx.select().from(memories)
    .where(and(eq(memories.id, id), eq(memories.status, "active"))).limit(1);
  if (!old) throw new ConflictError("target-not-active", [], "対象が active でない");

  const merged = {
    title: patch.title ?? old.title,
    content: patch.content ?? old.content,
    reason: patch.reason === undefined ? old.reason : patch.reason,
    evidence: patch.evidence ?? old.evidence,
    ttl_days: patch.ttl_days === undefined
      ? (old.expiresAt ? Math.ceil((old.expiresAt.getTime() - now.getTime()) / 86400000) : null)
      : patch.ttl_days,
  };

  // (c)+(d): type別規則 (§5.1) をマージ後の姿に再適用
  const issues = typeRuleIssues({
    type: old.type,
    ttl_days: merged.ttl_days,
    reason: merged.reason,
    evidence: merged.evidence,
  });
  if (issues.length > 0) throw new ApiError(400, "validation", issues.join(" / "));

  // (b): title か content が変わるなら必ず新しい埋め込みを作る
  const reEmbed = patch.title !== undefined || patch.content !== undefined;
  const next = reEmbed ? await embedWithRetry(merged.title + "\n" + merged.content) : null;

  // (a): 訂正後の姿で近傍ガードを掛け直す (自分自身は除外)
  if (next) {
    const near = await similarActivesOn(
      dbx,
      { type: old.scopeType, id: old.scopeId },
      next.embedding,
      simThreshold(),
      5,
      old.id,
    );
    if (near.length > 0) throw new ConflictError("similar-actives", near);
  }

  return writeTx(dbx, async (tx) => {
    const [locked] = await tx.select().from(memories)
      .where(and(eq(memories.id, id), eq(memories.status, "active"))).limit(1)
      .for("update");
    if (!locked) throw new ConflictError("target-not-active", [], "対象が active でない");
    assertEvent(locked.status, "correct");
    // H1 (第1報, 2026-11-24): tx の外で読んだ old と版が同じ時だけ書く
    // (楽観ロック)。読みとロックの間に別の訂正・削除が通っていたら 409 で
    // 差し戻す (マージをやり直させる)。
    if (locked.revision !== old.revision) {
      throw new ConflictError("stale-write", [], "変更の途中で対象が更新された");
    }
    const rev = await nextRevision(tx, locked.id, locked.revision);

    await tx.insert(memoryRevisions).values({
      memoryId: locked.id,
      revision: rev,
      snapshot: snapshot(locked),
      event: "correct",
      changedBy,
      changedAt: now,
      note: patch.note ?? null,
    });

    const [row] = await tx.update(memories).set({
      title: merged.title,
      content: merged.content,
      reason: merged.reason,
      evidence: merged.evidence,
      embedding: next?.embedding ?? old.embedding,
      embeddingModel: next?.model ?? old.embeddingModel,
      expiresAt: patch.ttl_days === undefined
        ? old.expiresAt
        : patch.ttl_days === null
          ? null
          : new Date(now.getTime() + patch.ttl_days * 86400000),
      revision: rev,
      updatedAt: now,
    }).where(eq(memories.id, id)).returning();
    return row;
  });
}

// --- 削除: 論理削除 + snapshot（§3.2）。生きた証拠はどの状態からでも冥送する ---
export const deleteMemory = async (id: string, changedBy: string): Promise<MemoryRow> => {
  // M12 (改訂4, 2026-11-24): 書込系 tx と同じ DB 側天井 (SET LOCAL) の内側へ。
  return writeTx(db, async (tx) => {
    const [old] = await tx.select().from(memories)
      .where(eq(memories.id, id)).limit(1)
      .for("update");
    if (!old) throw new ConflictError("target-missing", [], "対象が無い");
    assertEvent(old.status, "delete");
    const rev = await nextRevision(tx, old.id, old.revision);

    await tx.insert(memoryRevisions).values({
      memoryId: old.id,
      revision: rev,
      snapshot: snapshot(old),
      event: "delete",
      changedBy,
      changedAt: new Date(),
    });
    const [row] = await tx.update(memories)
      .set({ status: "deleted", revision: rev, updatedAt: new Date() })
      .where(eq(memories.id, id)).returning();
    return row;
  });
}

// --- 復活 (#2, M05): deleted/superseded/expired から active へ戻す。admin専用。 ---
// 置換の後継 (supersedes=このid で active な行) が残っている間は戻さない:
// 二重activeは「どちらが正か」を機械的に決められないので、人間に後始末を委ねる。
// todo は TTL 必須 (§5.1) なので、戻すなら bot と同じ既定の14日で作り直す。
// それ以外の型は TTL を外して恒久的な active に戻す。
export const restoreMemory = async (
  id: string,
  note: string | null,
  changedBy: string,
): Promise<MemoryRow> => {
  // 時刻はここで1点だけ取る (restore の基準)。
  const now = new Date();

  // M2 (第1報, 2026-11-24): 戻す先の現状を tx の外で先に読む
  // (近傍ガードと再埋め込みの判断に使う)。
  const [stale] = await db.select().from(memories)
    .where(eq(memories.id, id)).limit(1);
  if (!stale) {
    throw new ConflictError("target-missing", [], "対象が無い");
  }
  if (!EVENT_SOURCES.restore.includes(stale.status)) {
    throw new ConflictError("invalid-transition", [],
      "event=restore は status=" + stale.status + " からは不許可");
  }

  // M2: 埋め込みモデルが現行と違う/無い時は作り直す (別モデルの embedding が
  // 混ざったまま戻る事故を消す)。
  const currentModel = process.env.EMBEDDING_MODEL ?? null;
  let vec: number[] | null = stale.embedding;
  let model: string | null = stale.embeddingModel;
  let reEmbedded = false;
  if (vec == null || model == null || (currentModel != null && model !== currentModel)) {
    const re = await embedWithRetry(stale.title + "\n" + stale.content);
    vec = re.embedding;
    model = re.model;
    reEmbedded = true;
  }
  if (vec == null || model == null) {
    throw new ApiError(500, "internal", "embedding missing");
  }

  // M2: 近傍ガード (§5.1)。戻した先に似た active があると二重化するので、
  // 書く前に落とす。自分自身は active では無いが除外して問わない。
  const near = await similarActivesOn(
    db,
    { type: stale.scopeType, id: stale.scopeId },
    vec,
    simThreshold(),
    5,
    stale.id,
  );
  if (near.length > 0) {
    throw new ConflictError("similar-actives", near);
  }

  return writeTx(db, async (tx) => {
    const [old] = await tx.select().from(memories)
      .where(eq(memories.id, id)).limit(1).for("update");
    if (!old) throw new ConflictError("target-missing", [], "対象が無い");
    assertEvent(old.status, "restore");
    // M2: 後継の確認は直接の後継だけでは足りない。A→B→C と置換された
    // 状態で A を戻すと A と C が二重化するので、置換の連鎖を再帰的に
    // 辿って active な後継を探す。
    const chain = await tx.execute(sql`
      WITH RECURSIVE succ AS (
        SELECT id FROM memories WHERE supersedes = ${id}
        UNION ALL
        SELECT m.id FROM memories m JOIN succ s ON m.supersedes = s.id
      )
      SELECT s.id, m.title FROM succ s JOIN memories m ON m.id = s.id
      WHERE m.status = 'active' LIMIT 1`);
    const [activeSucc] = chain as unknown as Array<{ id: string; title: string }>;
    if (activeSucc) {
      throw new ConflictError("superseder-active", [activeSucc],
        "置換連鎖のどこかに active な後継が残っている。先にそれを delete するか別の道を整えること");
    }
    const rev = await nextRevision(tx, old.id, old.revision);
    await tx.insert(memoryRevisions).values({
      memoryId: old.id, revision: rev, snapshot: snapshot(old),
      event: "restore", changedBy, changedAt: now, note,
    });
    const [row] = await tx.update(memories)
      .set({
        status: "active",
        expiresAt: old.type === "todo" ? new Date(now.getTime() + 14 * 86400_000) : null,
        // M2: 再埋め込みが必要だった時だけベクトルも更新する
        ...(reEmbedded ? { embedding: vec, embeddingModel: model } : {}),
        revision: rev,
        updatedAt: now,
      })
      .where(eq(memories.id, id)).returning();
    return row;
  });
}

// --- 予行演習 (#5, M05): 保存せずに書込検査だけ通す。 ---
// createMemory と同じ順で id衝突 → 埋め込み → 近傍 → supersedes対象を見る。
// ConflictError は 409 にせず結果の一部として返す (当たるか否かを問う口なので)。
export type DryRunResult = {
  would_conflict: boolean;
  subtype: string | null;
  candidates: unknown[];
  conflict_message: string | null;
  est_tokens: number;
}

export const dryRunWrite = async (input: WriteMemoryInput): Promise<DryRunResult> => {
  const base: DryRunResult = {
    would_conflict: false,
    subtype: null,
    candidates: [],
    conflict_message: null,
    est_tokens: Math.ceil((input.title.length + input.content.length) / 2.2),
  };
  try {
    if (input.id) {
      const [dup] = await db.select({ id: memories.id }).from(memories)
        .where(eq(memories.id, input.id)).limit(1);
      if (dup) throw new ConflictError("duplicate-id", [], "指定された id は既に存在する");
    }
    const { embedding } = await embedWithRetry(input.title + "\n" + input.content);
    if (!input.confirm && !input.supersedes) {
      const candidates = await similarActives(input.scope, embedding, simThreshold());
      if (candidates.length > 0) throw new ConflictError("similar-actives", candidates);
    }
    if (input.supersedes) {
      const [target] = await db
        .select({ id: memories.id, scopeType: memories.scopeType, scopeId: memories.scopeId, title: memories.title })
        .from(memories)
        .where(and(eq(memories.id, input.supersedes), eq(memories.status, "active")))
        .limit(1);
      if (!target) {
        throw new ConflictError("supersedes-target-not-active", [], "supersedes 対象が active でない");
      }
      // M6 (第1報, 2026-11-24): dry_run も本番と同じ判定を返す。
      if (target.scopeType !== input.scope.type || target.scopeId !== input.scope.id) {
        throw new ConflictError("supersedes-scope-mismatch", [target], "supersedes 対象が別 scope に属する");
      }
    }
  } catch (e) {
    if (e instanceof ConflictError) {
      return {
        ...base,
        would_conflict: true,
        subtype: e.subtype,
        candidates: e.candidates,
        conflict_message: String(e.message),
      };
    }
    throw e; // 埋め込み失敗などは 500 経路に任せる
  }
  return base;
}

// --- 検索: semantic 近傍（§5.2） ---
export const searchMemories = async (p: SearchInput) => {
  const { embedding: vec, model } = await embedWithRetry(p.q);
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
  // 近傍索引の窓を通す (vectorScan, M05): HNSW はフィルタ (scope/trust 等) を
  // 無視して全体近傍のみ返すので、 iterative scan なしでは該当行が 0 件に
  // なる実測があった。ここも tx 内で SET LOCAL してから同じ接続で読む。
  const rows = await vectorScanOn(db, (tx) => tx.select({
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
    .limit(p.limit));
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
export const buildContext = async (scope: { type: string; id: string }, maxItems: number) => {
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
export const verifyGithubSignature = (raw: string, sig: string | undefined): boolean => {
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

type GithubIssue = {
  title?: string;
  body?: string | null;
  html_url?: string;
  url?: string;          // API URL
  labels?: Array<{ name: string } | string>;
  user?: { login?: string };
}

// issue本文から "### 見出し" 直下を取り出す（issueフォームの欄に対応）
const section = (body: string, heading: string): string => {
  const re = new RegExp("###\\s*" + heading + "\\s*\\n([\\s\\S]*?)(?=\\n###|$)");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

export const handleGithubIssue = async (payload: unknown): Promise<{ ok: boolean; skipped?: string; memory?: unknown; conflict?: unknown }> => {
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
  // H4 (第1報, 2026-11-24): フォーム欄が空だと GitHub は _No response_ を
  // 埋める。欄の実体は「空」なのでその値は空として扱う (decision の理由
  // 必須が欄送りで素通りする事故を消す)。あわせて「根拠permalink」と
  // ttl_days の2欄を欄として読む。
  const rawSection = (heading: string): string => {
    const v = section(body, heading);
    return v === "" || v === "_No response_" ? "" : v;
  };
  const content = rawSection("内容") || body;
  const reason = rawSection("理由") || undefined;
  const evidenceField = rawSection("根拠permalink");
  const ttlField = rawSection("ttl_days");
  const evidenceUrl = evidenceField !== "" ? evidenceField : (body.match(/https?:\/\/\S+/) ?? [])[0];

  const ttlLabel = labels.find((n) => n.startsWith("ttl:"));
  const labelTtl = ttlLabel ? Number(ttlLabel.split(":")[1]) : null;
  // 優先順位: フォーム欄 > ttl:N ラベル (旧形式) > todo の既定14日。それ以外は永続。
  const ttlDays: number | null = ttlField !== ""
    ? Number(ttlField)
    : (labelTtl != null && Number.isFinite(labelTtl) ? labelTtl : (type === "todo" ? 14 : null));

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
  const actor = "github:" + (issue.user?.login ?? "unknown");

  // H4 (第1報, 2026-11-24): issue と記憶を 1:1 で結ぶ。目印は evidence の
  // kind=issue ref=issue URL (jsonb containment で引く)。「edited」は対応する
  // active 記憶を PATCH に載せ替え、開き直りの新規作成 (409 と
  // memory:conflict ラベルの連発) を止める。対象が無い/activeでない時は
  // 従来どおり新規作成へ回す。
  // M11 (改訂4, 2026-11-24): 同じ issue を根拠に挙げた別由来の記憶 (API 書込
  // 等、created_by が github: 始まりでないもの) まで載し替え得たので、
  // 対象はこの窓口が作った記憶 (created_by LIKE 'github:%') に限る。
  if (p.action === "edited") {
    const issueUrl = issue.html_url ?? "about:blank";
    const rows = await db.execute(sql`
      SELECT id, status FROM memories
      WHERE evidence @> ${JSON.stringify([{ kind: "issue", ref: issueUrl }])}::jsonb
        AND created_by LIKE 'github:%'
      ORDER BY (status = 'active') DESC, created_at ASC
      LIMIT 1`);
    const [existing] = rows as unknown as Array<{ id: string; status: string }>;
    if (existing && existing.status === "active") {
      const patch = {
        title: issue.title ?? "(untitled)",
        content,
        ...(reason ? { reason } : {}),
        evidence,
        ...(ttlDays !== null && Number.isFinite(ttlDays) ? { ttl_days: ttlDays } : {}),
        note: "issue編集 (edited) を反映",
      };
      const pp = parseBody(CorrectMemory)(patch);
      if (!pp.success) return { ok: false, skipped: "invalid patch: " + String(pp.error.issues[0]?.message) };
      try {
        const row = await correctMemory(existing.id, pp.data, actor);
        return { ok: true, memory: { id: row.id, title: row.title, updated: true } };
      } catch (e) {
        if (e instanceof ConflictError) {
          await addLabel(issue, "memory:conflict");
          return { ok: true, conflict: e.candidates };
        }
        throw e;
      }
    }
  }

  const parsed = parseBody(WriteMemory)(input);
  if (!parsed.success) return { ok: false, skipped: "invalid input: " + String(parsed.error.issues[0]?.message) };

  try {
    const row = await createMemory(parsed.data, actor);
    return { ok: true, memory: { id: row.id, title: row.title } };
  } catch (e) {
    if (e instanceof ConflictError) {
      await addLabel(issue, "memory:conflict");
      return { ok: true, conflict: e.candidates };
    }
    throw e;
  }
}

const addLabel = async (issue: GithubIssue, name: string) => {
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
export const verifySlackSignature = (raw: string, sig: string | undefined, ts: string | undefined): boolean => {
  const secret = process.env.SLACK_SIGNING_SECRET ?? "";
  if (!secret || !sig || !ts) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mac = createHmac("sha256", secret).update("v0:" + ts + ":" + raw).digest("hex");
  const a = Buffer.from("v0=" + mac);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const handleSlack = async (raw: string) => {
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
    // M5 (第1報, 2026-11-24): 記憶本文が意図せずチャンネル全員に見える
    // 事故を消す。既定を自分にだけ見える ephemeral にする (response_url への
    // 非同期送信は今後の改善枠)。
    return { response_type: "ephemeral", blocks };
  } catch (e) {
    // N-4: 例外の中身 (DB接続文字列等) がSlackに露出しないようにログへ。
    console.error("handleSlack search failed:", e);
    return { response_type: "ephemeral", text: "検索に失敗しました (内部エラー)" };
  }
}

// ===== crons (src/cron/ttl-sweep.ts, src/cron/audit-export.ts) =====

// 忘却: 期限を過ぎたactive記憶を expired へ（§3.4/§12.4）
// tx内で行ロックを取り直し、並走イベントに取りこぼさない (M02)
export const ttlSweep = async (): Promise<number> => {
  const now = new Date();
  const victims = await db.select().from(memories)
    .where(and(eq(memories.status, "active"), isNotNull(memories.expiresAt), lt(memories.expiresAt, now)));
  let expired = 0;
  // M12 (改訂4, 2026-11-24): 掃除も書込系 tx と同じ天井 (SET LOCAL) の内側へ。
  await writeTx(db, async (tx) => {
    for (const victim of victims) {
      const [old] = await tx.select().from(memories)
        .where(and(eq(memories.id, victim.id), eq(memories.status, "active"))).limit(1)
        .for("update");
      if (!old) continue; // 並走で別のイベントが入った。WHERE句で二重sweep防止=冪等
      assertEvent(old.status, "expire");
      const rev = await nextRevision(tx, old.id, old.revision);
      await tx.insert(memoryRevisions).values({
        memoryId: old.id,
        revision: rev,
        snapshot: JSON.parse(JSON.stringify(old)) as object,
        event: "expire",
        changedBy: "cron:ttl-sweep",
        changedAt: now,
      });
      await tx.update(memories)
        .set({ status: "expired", revision: rev, updatedAt: now })
        .where(eq(memories.id, old.id));
      expired++;
    }

    // 補助表の清掃 (N-1, 2026-11-23): sweep と同じ窓で回すので別枠cronは要らない。
    // ratelimits は古い窓(2h)、idempotency_keys は7日、reference_logs は60日で廃棄。
    await tx.delete(ratelimits)
      .where(lt(ratelimits.windowStart, new Date(now.getTime() - 2 * 3600_000)));
    await tx.delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - 7 * 86400_000)));
    await tx.delete(referenceLogs)
      .where(lt(referenceLogs.createdAt, new Date(now.getTime() - 60 * 86400_000)));
  });
  return expired;
}

// 監査: 直近25時間の revision 履歴を吐き出す。journalctl へ
// （窓を25hにして多重実行に強くしている）
export const auditExport = async (): Promise<number> => {
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

// L3 (第1報, 2026-11-24): type には実在しない仮ドメイン (memory.example) を
// 返さず、README のエラー型一覧を指す identifier URL を返す。機械種は title。
const ERRORS_DOC_URL = "https://github.com/sh-sunfaded/memory-api-on-sakura/blob/main/README.md#エラー型一覧";

const problem = (c: any, status: number, type: string, detail?: unknown) => {
  return c.json({
    type: ERRORS_DOC_URL,
    title: type,
    status,
    detail: detail ?? null,
  }, status);
}

// H5 (第1報, 2026-11-24): :id 系の全経路で UUID 形式を先に検査する。
// 素通りさせると Postgres の型エラー (22P02) が 500 で吹き出す。
// 形式が違う id も「実在しない id」と同じ扱いの 404 にする。
const isUuid = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// 409 の導線 (#4, M05): AI が次の一手に迷わないよう具体的な行動例を添える。
// 409 は差し戻して終わりではなく、再提出の道を示すための応答にする。
const nextActionsFor = (subtype: string, candidates: unknown[]): Array<Record<string, unknown>> => {
  const ids = (candidates as Array<{ id?: string }>)
    .map((x) => x?.id)
    .filter((x): x is string => typeof x === "string");
  switch (subtype) {
    case "similar-actives": {
      const actions: Array<Record<string, unknown>> = ids.map((id) => ({
        action: "supersede",
        description: "この記憶の後継として置き換える",
        request: { method: "POST", path: "/memory", supersedes: id },
      }));
      actions.push({
        action: "confirm",
        description: "重複を承知の上で強制書込する",
        request: { method: "POST", path: "/memory", confirm: true },
      });
      actions.push({ action: "reword", description: "内容を変えて新規として再送する" });
      return actions;
    }
    case "duplicate-id":
      return [
        { action: "use-existing", description: "既存の記憶を PATCH で訂正する", request: { method: "PATCH", path: "/memory/<id>" } },
        { action: "new-id", description: "id を省略して新規作成する", request: { method: "POST", path: "/memory" } },
      ];
    case "target-not-active":
    case "invalid-transition":
      return [
        { action: "inspect", description: "対象の現状と履歴を確認する", request: { method: "GET", path: "/memory/<id>/history" } },
      ];
    case "superseder-active":
      return [
        { action: "inspect", description: "後継の履歴を確認する", request: { method: "GET", path: "/memory/<id>/history" } },
        { action: "delete-superseder", description: "後継を admin で delete してから restore をやり直す" },
      ];
    case "supersedes-target-not-active":
      return [
        { action: "inspect", description: "置換対象を確認する", request: { method: "GET", path: "/memory/<id>/history" } },
        { action: "reword", description: "supersedes を外して新規として出す", request: { method: "POST", path: "/memory" } },
      ];
    case "supersedes-scope-mismatch":
      return [
        { action: "use-existing", description: "対象の scope に既に存在するなら PATCH で訂正する", request: { method: "PATCH", path: "/memory/<id>" } },
        { action: "move-scope", description: "対象と同じ scope に内容を変えて書き直す", request: { method: "POST", path: "/memory" } },
      ];
    case "stale-write":
      return [
        { action: "inspect", description: "他の変更が先に通った。最新の姿を確認して作り直す", request: { method: "GET", path: "/memory/<id>" } },
      ];
    default:
      return [];
  }
}

const conflictOrError = (c: any, e: unknown) => {
  if (e instanceof ConflictError) {
    return c.json({
      type: ERRORS_DOC_URL,
      title: "similar memories exist",
      status: 409,
      detail: "近い記憶が既に存在する。supersedes か confirm を使うか、内容を変えて再提出せよ (§5.1)",
      subtype: e.subtype,
      candidates: e.candidates,
      next_actions: nextActionsFor(e.subtype, e.candidates),
    }, 409);
  }
  if (e instanceof ApiError) return problem(c, e.status, e.type, String(e.message));
  console.error("unhandled:", e);
  return problem(c, 500, "internal");
}

// 参照ログ（会計層の種）。応答を遅らせないよう waitUntil に載せる
// N-3, 2026-11-23: 実行文脈外 (batch等) では waitUntil が無いので fire-and-forget になる。
// 取りこぼしの実測は reference_logs 側との差分で今後拾う。
// 常駐サーバーでは応答後もプロセスが生き続けるので、載らず fire-and-forget
// でも参照ログは書かれる。
const reflog = (c: any, kind: string, subject: string, scopeType: string, scopeId: string, query: string | null, resultCount: number) => {
  const p = db.insert(referenceLogs).values({
    kind, subject, scopeType, scopeId, query, resultCount,
  }).then(() => {}, () => {});
  try { c.executionCtx.waitUntil(p); } catch { /* executionCtx が無い呼び出しでは握り潰す */ }
}

// --- 基礎 ---
// M1 (第1報, 2026-11-24): /healthz は生存確認だけに落とす。旧実装は1回で
// 4クエリ走り、件数・埋め込みモデル・索引名が無認証で見えた。中身の診断は
// read 権限の内側にある /healthz/detail に分離した。
app.get("/healthz", async (c) => {
  await db.execute(sql`SELECT 1`);
  return c.json({ status: "ok", db: "ok" });
});

// #6 (M05) + M1: deploy直後の一発診断。DB中身とenvの整合まで返すが、
// read トークンの内側に置く。
app.get("/healthz/detail", requireRead, async (c) => {
  const statusRows = await db.execute(
    sql`SELECT status, COUNT(*)::int AS n FROM memories GROUP BY status ORDER BY status`);
  const modelRows = await db.execute(
    sql`SELECT DISTINCT embedding_model FROM memories WHERE embedding_model IS NOT NULL`);
  const idxRows = await db.execute(
    sql`SELECT indexname FROM pg_indexes WHERE tablename = 'memories' ORDER BY indexname`);
  const envModel = process.env.EMBEDDING_MODEL ?? null;
  const dbModels = (modelRows as unknown as Array<{ embedding_model: string }>)
    .map((r) => r.embedding_model);
  const counts: Record<string, number> = {};
  for (const r of statusRows as unknown as Array<{ status: string; n: number }>) {
    counts[r.status] = Number(r.n);
  }
  return c.json({
    status: "ok",
    db: "ok",
    memories: counts,
    embedding: {
      env_model: envModel,
      models_in_db: dbModels,
      // DBに残る埋め込みが全て現行envのモデルと一致しているか (混在の検知)
      consistent: envModel != null && dbModels.every((m) => m === envModel),
    },
    indexes: (idxRows as unknown as Array<{ indexname: string }>).map((r) => r.indexname),
  });
});

// --- 診断: env変数の「有無」だけ返す(値は返さない)。検収が済んだら削る ---


app.onError((e, c) => conflictOrError(c, c.error ?? e));

// --- 書込（§5.1: 409摩擦 / 冪等 / レート制限） ---
app.post("/memory", requireWrite, async (c) => {
  const token = c.get("token");
  // parseBody (L9, 第1報): 400 の detail は {path, message}[] の契約で返す。
  const parsed = parseBody(WriteMemory)(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  // L13 (改訂4, 2026-11-24): api_tokens.name には一意制約が無いので、窓の
  // 区別は行の id (uuid) で取る。同名の別 token を別枠に数える。
  const rate = await checkAndIncr("write:" + token.id, Number(process.env.RATE_LIMIT_PER_HOUR ?? "60"));
  if (!rate.allowed) return problem(c, 429, "rate-limit", "write rate exceeded");

  // 予行演習 (#5, M05): 保存せずに書込検査だけ通し、結果は 200 で返す。
  // 「409になるか」を問う口なので、当たりも外れも結果のうち (409にはしない)。
  // 埋め込みを呼ぶので書込の窓は消費する。冪等キャッシュには載せない。
  if (parsed.data.dry_run) {
    try {
      const dr = await dryRunWrite(parsed.data);
      reflog(c, "dry_run", token.name, parsed.data.scope.type, parsed.data.scope.id, parsed.data.title, 0);
      return c.json({
        dry_run: true,
        ...dr,
        next_actions: dr.would_conflict ? nextActionsFor(dr.subtype ?? "", dr.candidates) : [],
      });
    } catch (e) {
      return conflictOrError(c, e);
    }
  }

  // H3 (第1報, 2026-11-24): キーは「token id#受領値」に scoped する
  // (旧実装は生値だったので、他人の token で Read するだけで他人の書込
  // 応答が覗けた)。再送の fast-path は従来どおり照会で返す。
  // L13 (改訂4, 2026-11-24): api_tokens.name は一意でないので id (uuid) で
  // 区別する。同名の別 token が互いのキャッシュを覗き合わない。
  const idemRaw = c.req.header("idempotency-key");
  const idem = idemRaw ? token.id + "#" + idemRaw : null;
  if (idem) {
    const [cached] = await db.select().from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idem)).limit(1);
    if (cached) return c.json(cached.response, 201);
  }

  try {
    const row = await createMemory(parsed.data, "token:" + token.name, "provisional", idem ?? undefined);
    reflog(c, "write", token.name, row.scopeType, row.scopeId, parsed.data.title, 1);
    return c.json(memView(row), 201);
  } catch (e) {
    if (e instanceof IdemReplay) {
      // 同 tx 内の先着 (並走) : 記憶の作成は巻き戻っている。保存済み応答で応える。
      if (e.response == null) return problem(c, 500, "internal");
      return c.json(e.response, 201);
    }
    return conflictOrError(c, e);
  }
});

// --- 検索（§5.2） ---
app.post("/memory/search", requireRead, async (c) => {
  const token = c.get("token");
  // N-2 (M04): 読み取りの窓。書込 (RATE_LIMIT_PER_HOUR) とは別枠。
  // M05: 窓は検索・一覧・履歴の読み全口で共有する (subject: read:<token>)。
  // L13 (改訂4, 2026-11-24): 窓の区別は token の id (uuid) で取る。
  const readRate = await checkAndIncr("read:" + token.id, Number(process.env.READ_RATE_LIMIT_PER_HOUR ?? "240"));
  if (!readRate.allowed) return problem(c, 429, "rate-limit", "read rate limit exceeded");
  const parsed = parseBody(SearchMemory)(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  const result = await searchMemories(parsed.data);
  reflog(c, "search", token.name, parsed.data.scope.type, parsed.data.scope.id, parsed.data.q, result.results.length);
  return c.json(result);
});

// --- 一覧 (#3, M05): scope/type/status 絞り込み + ページ送り ---
app.get("/memory", requireRead, async (c) => {
  const token = c.get("token");
  const readRate = await checkAndIncr("read:" + token.id, Number(process.env.READ_RATE_LIMIT_PER_HOUR ?? "240"));
  if (!readRate.allowed) return problem(c, 429, "rate-limit", "read rate limit exceeded");
  const parsed = parseBody(ListQuery)({
    scope_type: c.req.query("scope_type") || undefined,
    scope_id: c.req.query("scope_id") || undefined,
    type: c.req.query("type") || undefined,
    status: c.req.query("status") || undefined,
    limit: Number(c.req.query("limit") ?? 20),
    offset: Number(c.req.query("offset") ?? 0),
  });
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  const q = parsed.data;
  // M4 (第1報, 2026-11-24): scope を限定しない一覧は status を active 既定に
  // 限定する (read 権限だけで共有 DB の削除済み本文まで読めるのを防ぐ)。
  // scope を指定した照会は引き続き全 status を読める。
  const unscoped = !q.scope_type && !q.scope_id;
  const conds = [
    q.scope_type ? eq(memories.scopeType, q.scope_type) : undefined,
    q.scope_id ? eq(memories.scopeId, q.scope_id) : undefined,
    q.type ? eq(memories.type, q.type) : undefined,
    q.status ? eq(memories.status, q.status)
      : unscoped ? eq(memories.status, "active") : undefined,
  ].filter(Boolean);
  const rows = await db.select().from(memories)
    .where(and(...conds))
    .orderBy(desc(memories.updatedAt), desc(memories.createdAt))
    .limit(q.limit).offset(q.offset);
  const [counted] = await db.select({ n: sql<number>`count(*)::int` })
    .from(memories).where(and(...conds));
  reflog(c, "list", token.name, q.scope_type ?? "", q.scope_id ?? "", null, rows.length);
  return c.json({ items: rows.map(memView), total: Number(counted.n), limit: q.limit, offset: q.offset });
});

// --- 前提の要約（§5.2） ---
app.get("/memory/context", requireRead, async (c) => {
  const token = c.get("token");
  // M4 (第1報, 2026-11-24): context も読み取りの窓の内側 (search/list/history と共有)。
  const readRate = await checkAndIncr("read:" + token.id, Number(process.env.READ_RATE_LIMIT_PER_HOUR ?? "240"));
  if (!readRate.allowed) return problem(c, 429, "rate-limit", "read rate limit exceeded");
  const parsed = parseBody(ContextQuery)({
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
  // H5 (第1報, 2026-11-24): 形式が違う id は DB に届けず 404。
  if (!isUuid(c.req.param("id"))) return problem(c, 404, "not-found");
  // M4 (第1報, 2026-11-24): :id も読み取りの窓の内側 (search/list/history と共有)。
  const token = c.get("token");
  const readRate = await checkAndIncr("read:" + token.id, Number(process.env.READ_RATE_LIMIT_PER_HOUR ?? "240"));
  if (!readRate.allowed) return problem(c, 429, "rate-limit", "read rate limit exceeded");
  const [row] = await db.select().from(memories)
    .where(eq(memories.id, c.req.param("id"))).limit(1);
  if (!row) return problem(c, 404, "not-found");
  return c.json(memView(row));
});

// --- 履歴 (#1, M05): append-only の行を新しいイベント順で読む ---
// 注: create は仮想イベント 1 (M02採番設計) なので、変化を受けていない
// 新規記憶の履歴は 0 行から始まる。snapshot は「そのイベントの直前の姿」。
app.get("/memory/:id/history", requireRead, async (c) => {
  // H5 (第1報, 2026-11-24): 形式が違う id は DB に届けず 404。
  if (!isUuid(c.req.param("id"))) return problem(c, 404, "not-found");
  const token = c.get("token");
  const readRate = await checkAndIncr("read:" + token.id, Number(process.env.READ_RATE_LIMIT_PER_HOUR ?? "240"));
  if (!readRate.allowed) return problem(c, 429, "rate-limit", "read rate limit exceeded");
  const parsed = parseBody(HistoryQuery)({
    limit: Number(c.req.query("limit") ?? 50),
    offset: Number(c.req.query("offset") ?? 0),
  });
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  const id = c.req.param("id");
  const [row] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
  if (!row) return problem(c, 404, "not-found");
  const revs = await db.select().from(memoryRevisions)
    .where(eq(memoryRevisions.memoryId, id))
    .orderBy(desc(memoryRevisions.revision))
    .limit(parsed.data.limit).offset(parsed.data.offset);
  const [counted] = await db.select({ n: sql<number>`count(*)::int` })
    .from(memoryRevisions).where(eq(memoryRevisions.memoryId, id));
  reflog(c, "history", token.name, row.scopeType, row.scopeId, null, revs.length);
  return c.json({
    id: row.id,
    title: row.title,
    status: row.status,
    revision: row.revision,
    total: Number(counted.n),
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    revisions: revs.map((r) => {
      // snapshot から埋め込み (1536次元) だけは応答に乗せない
      const snap = { ...(r.snapshot as Record<string, unknown>) };
      delete snap.embedding;
      return {
        revision: r.revision,
        event: r.event,
        changed_by: r.changedBy,
        changed_at: r.changedAt.toISOString(),
        note: r.note,
        snapshot: snap,
      };
    }),
  });
});

// --- 訂正（§3.2: snapshotを残す） ---
app.patch("/memory/:id", requireWrite, async (c) => {
  // H5 (第1報, 2026-11-24): 形式が違う id は DB に届けず 404。
  if (!isUuid(c.req.param("id"))) return problem(c, 404, "not-found");
  const token = c.get("token");
  const parsed = parseBody(CorrectMemory)(await c.req.json().catch(() => null));
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
  // H5 (第1報, 2026-11-24): 形式が違う id は DB に届けず 404。
  if (!isUuid(c.req.param("id"))) return problem(c, 404, "not-found");
  const token = c.get("token");
  try {
    await deleteMemory(c.req.param("id"), "token:" + token.name);
    return c.body(null, 204);
  } catch (e) {
    return conflictOrError(c, e);
  }
});

// --- 復活 (#2, M05): admin=人間が誤操作を巻き戻す ---
app.post("/memory/:id/restore", requireAdmin, async (c) => {
  // H5 (第1報, 2026-11-24): 形式が違う id は DB に届けず 404。
  if (!isUuid(c.req.param("id"))) return problem(c, 404, "not-found");
  const token = c.get("token");
  const parsed = parseBody(RestoreInput)(await c.req.json().catch(() => ({})));
  if (!parsed.success) return problem(c, 400, "validation", parsed.error.issues);
  try {
    const row = await restoreMemory(c.req.param("id"), parsed.data.note ?? null, "token:" + token.name);
    return c.json(memView(row));
  } catch (e) {
    return conflictOrError(c, e);
  }
});

// --- cron（systemd timer 等は GET で叩く; Authorization: Bearer CRON_SECRET） ---
const cronGuard = createMiddleware<Env>(async (c, next) => {
  const secret = process.env.CRON_SECRET;
  // L14 (改訂4, 2026-11-24): Bearer と CRON_SECRET の比較は定数時間で
  // (素の === は先頭部分の時間差で情報が洩れる)。
  if (!secret || !safeEqual(c.req.header("authorization") ?? "", "Bearer " + secret)) {
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
  // N-2, 2026-11-23: 署名が正しくても流し込まれる窓を作る。
  const ghRate = await checkAndIncr("hook:github", Number(process.env.HOOK_RATE_LIMIT_PER_HOUR ?? "60"));
  if (!ghRate.allowed) return c.json({ title: "rate-limit" }, 429);
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return c.json({ title: "bad payload" }, 400); }
  // N-4: 例外の中身は応答に乗せずログに置く。
  const out = await handleGithubIssue(payload).catch((e) => {
    console.error("hooks/github unhandled:", e);
    return { ok: false, error: "internal error" };
  });
  return c.json(out);
});

// --- 人間の読み口: Slack /why（§4） ---
app.post("/hooks/slack", async (c) => {
  const raw = await c.req.raw.clone().text();
  if (!verifySlackSignature(raw, c.req.header("x-slack-signature"), c.req.header("x-slack-request-timestamp"))) {
    return c.json({ title: "unauthorized" }, 401);
  }
  // N-2, 2026-11-23: フック共通の窓。
  const slackRate = await checkAndIncr("hook:slack", Number(process.env.HOOK_RATE_LIMIT_PER_HOUR ?? "60"));
  if (!slackRate.allowed) return c.json({ title: "rate-limit" }, 429);
  return c.json(await handleSlack(raw));
});

// ===== dual-contract handler (src/entry.ts + 正規化) =====
//
// dual-contract:
//  - web-standard Request が来ればそのまま app へ。
//    逆プロキシ等から legacy (req, res) で渡されても応える。
//  - /api/* prefix が付いた path は剥ぐ正規化だけ行う。
//    どちらの呼び出し方でも同一の routing に落ちる。

const stripApiPrefix = (pathname: string): string => {
  if (pathname === "/api") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice("/api".length);
  return pathname;
}

const reqUrl = (req: any): URL => {
  const host = typeof req.headers?.get === "function"
    ? req.headers.get("host") ?? "localhost"
    : String(req.headers?.host ?? "localhost");
  return new URL(String(req.url || "/"), "https://" + host);
}

const readBody = async (req: any): Promise<Buffer | undefined> => {
  const method = String(req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  if (typeof req?.arrayBuffer === "function") return Buffer.from(await req.arrayBuffer());
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

// Hono の c.executionCtx は app.fetch の第3引数に executionCtx 相当を
// 渡したときだけ有効になる。ここでは互換の実行文脈を注入する。
// 常駐サーバー (src/serve.ts) では応答後もプロセスが生き続けるので、
// 載らない環境では fire-and-forget のままでも参照ログは書かれる (契約不変)。
const honoExecutionCtx = {
  waitUntil: (_p: Promise<unknown>): void => {
    // 常駐プロセスでは応答後も生き続けるため、載せなくても書込みは完了する
  },
  },
  passThroughOnException: (): void => {},
  props: {} as Record<string, unknown>,
};

const handleWeb = async (request: Request): Promise<Response> => {
  try {
    const u = new URL(request.url);
    const stripped = stripApiPrefix(u.pathname);
    if (stripped === u.pathname) return await app.fetch(request, undefined, honoExecutionCtx);
    // /api/* 直呼びの正規化: query・headers・body は保全する
    const target = new URL(stripped + u.search, u.origin);
    const method = request.method.toUpperCase();
    const init: RequestInit = { method, headers: request.headers };
    if (method !== "GET" && method !== "HEAD" && request.body) {
      init.body = request.body;
      // @ts-ignore duplex は undici のオプション
      init.duplex = "half";
    }
    return await app.fetch(new Request(target, init), undefined, honoExecutionCtx);
  } catch (e) {
    // N-4, 2026-11-23: detail に String(e) を乗せると内部情報が応答に出る。ログへ。
    console.error("handleWeb unhandled:", e);
    return Response.json(
      { type: ERRORS_DOC_URL, title: "internal", status: 500, detail: null },
      { status: 500 },
    );
  }
}

// L7 (第1報, 2026-11-24): ログとスタックトレースで関数名が出るよう
// 名前付きの handler にしてから default export する。
const handler = async (req: any, res: any): Promise<Response | void> => {
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
export default handler;

export const config = { runtime: "nodejs" };
