-- 001_indexes.sql: drizzle-kit push 後に psql 等で実行する。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- HNSW(コサイン)・active限定（仕様書v0.3 §3.2/§12.3）
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx
  ON memories USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active' AND embedding IS NOT NULL;

-- trigram（拡張検索用, §7）
CREATE INDEX IF NOT EXISTS memories_trgm_idx
  ON memories USING gin ((title || ' ' || content) gin_trgm_ops);
