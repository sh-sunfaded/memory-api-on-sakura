# memory-api-on-sakura

AIに根拠と履歴付きの記憶を持たせるREST API。**さくらのVPS + さくらのAI Engine の上で最初から組み上げて、24時間動かし続ける**構築の記録。
このrepoのコミット履歴とVPS側の運用ログが、そのまま動作の証拠になるように作る。

## このAPIの約束

- 書込(type=decision)には根拠(evidence)と理由(reason)が必須。履歴は絶対に消さず、revision snapshot として残る
- 意味検索は pgvector のコサイン近傍。埋め込みは OpenAI互換 `/v1/embeddings` への fetch のみ(接続先は環境変数で指す)
- 類似0.85超の書込は 409 で差し戻す。書き手に「既に書いたもの」を確認させる摩擦
- トークンは read / write / admin の3権限。削除は admin=人間だけ。DBには sha256 ハッシュのみ
- レート制限は固定1時間窓の60回(書込)。超過は 429

## 状態(2026-11-23)

構築開始。次の一手は、さくらのAI Engine の埋め込みモデルの次元を実測し、schema `vector(N)` の N を確定すること(`npm run probe`)。それまで vector(1536) は仮置き。

## 動かす(VPS上で)

```bash
git clone https://github.com/sh-sunfaded/memory-api-on-sakura.git
cd memory-api-on-sakura
npm install
cp .env.example .env   # .env に実値を整える(秘密は絶対にコミットしない)
npm run db:push
psql "$DATABASE_URL" -f sql/001_indexes.sql
npm run token -- demo read
npm run dev            # http://localhost:3000/healthz
```

## 検証と運用の器具

| コマンド | 役割 |
|---|---|
| `npm run probe` | 埋め込みエンドポイントを本番DBに触れずに実測(次元・レイテンシ・golden当たり) |
| `npm run eval` | 固定オラクル(data/golden.csv)で top-1/top-3 と p50/p95 |
| `npm run simdistr` | active記憶全ペアの類似度分布(409閾値はこの実測の上に載せる) |
| `npm run dump` | 全記憶と全履歴のJSONエクスポート(embeddingは既定で除外) |

## 保安の家規

- 個人情報・顧客機密は書かない(書いた瞬間に防ぐ。掃除に頼らない)
- 秘密値は環境変数にのみ置く。repoには .env.example の鍵穴だけ
- 公開するのは read 権限トークン経由の検索と context のみ

コード文中の §参照は当初の設計書の章番号(文書はrepo外)。

## License

MPL-2.0(各ファイルのヘッダと LICENSE/COPYING のとおり)。
