-- 001_indexes.sql: drizzle-kit push 後に psql 等で実行する。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- HNSW(コサイン)・active限定（仕様書v0.3 §3.2/§12.3）
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx
  ON memories USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active' AND embedding IS NOT NULL;

-- trigram (L5, 問題報告書第1報 2026-11-24): 現在の検索経路 (ベクトル近傍のみ) では
-- 未使用。将来のハイブリッド検索 (キーワードtrigram + ベクトル) のための先行配置。
CREATE INDEX IF NOT EXISTS memories_trgm_idx
  ON memories USING gin ((title || ' ' || content) gin_trgm_ops);
