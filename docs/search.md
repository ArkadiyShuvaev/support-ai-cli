# Hybrid Search

The agent retrieves Knowledge Base (KB) articles using a **hybrid search** strategy that combines lexical matching (BM25) with semantic similarity (k-NN), then merges the two ranked lists using **Reciprocal Rank Fusion (RRF)**.

## Architecture Overview

```
┌─────────────────┐
│  Ticket text    │
└────┬────────┬───┘
     │        │
     ▼        ▼
 ┌───────┐  ┌────────────────┐
 │ BM25  │  │ Embedding      │
 │ query │  │ server (8001)  │
 └───┬───┘  └───────┬────────┘
     │              │ 512-dim vector
     ▼              ▼
 ┌───────┐     ┌─────────┐
 │  Top  │     │  Top    │
 │  10   │     │  10     │
 └───┬───┘     └────┬────┘
     │              │
     └──────┬───────┘
            ▼
      ┌───────────┐
      │    RRF    │
      │  (k = 60) │
      └─────┬─────┘
            ▼
       Top 3 articles → injected
       into LLM system prompt as XML
```

## Components

### 1. BM25 — Keyword Search

A `multi_match` query across all text fields and their language-specific sub-fields.

**Fields searched** (7 total):

| Field     | Analyzers                       | Boost |
| --------- | ------------------------------- | ----- |
| `title`   | `standard`, `french`, `english` | 3x    |
| `content` | `standard`, `french`, `english` | 1x    |

Each text field is indexed three times using multi-field mappings so that both French and English content is stemmed and matched correctly. The `title` field gets a 3x boost because article titles are the strongest relevance signal.

### 2. k-NN — Semantic Vector Search

An approximate nearest-neighbour search over the `embedding` field using HNSW.

| Parameter              | Value                                  |
| ---------------------- | -------------------------------------- |
| Model                  | `distiluse-base-multilingual-cased-v1` |
| Dimensions             | 512                                    |
| ANN algorithm          | HNSW (via `nmslib` engine)             |
| Space type             | `cosinesimil`                          |
| HNSW `ef_construction` | 128                                    |
| HNSW `m`               | 16                                     |
| `ef_search`            | 100                                    |

The ticket text is sent to the **embedding server** (`POST /embed` on port 8001), which runs the same SentenceTransformer model used at index time. The returned 512-dimensional vector is then used as the query vector for k-NN search.

### 3. RRF — Reciprocal Rank Fusion

Both ranked lists (BM25 and k-NN, 10 results each) are merged using the RRF formula:

```
score(doc) = Σ  1 / (k + rank + 1)
```

where `k = 60` (standard default from Cormack & Clarke 2009) and `rank` is the 0-based position in each list. Documents that appear in both lists accumulate score from both, rewarding agreement between lexical and semantic signals.

The top **3** articles by RRF score are returned to the LLM as XML.

## Index Mapping

Defined in `data-pipeline/indexer/build_index.py`. The index `support-cli-kb` uses these settings:

```json
{
  "settings": {
    "index": {
      "knn": true,
      "knn.algo_param.ef_search": 100
    }
  }
}
```

**Field types:**

| Field       | Type                   | Notes                                           |
| ----------- | ---------------------- | ----------------------------------------------- |
| `id`        | `keyword`              | Article identifier (slug)                       |
| `title`     | `text` + `.fr` + `.en` | Multi-field with `french` / `english` analyzers |
| `content`   | `text` + `.fr` + `.en` | Full article body; also used as embedding input |
| `page_ref`  | `keyword`              | Notion page UUID                                |
| `embedding` | `knn_vector` (512d)    | HNSW / nmslib / cosinesimil                     |

## Data Flow

### Indexing (offline, Python)

Two-step process:

**Step 1 — Scrape** (run when Notion content changes):

```bash
cd data-pipeline
uv run python indexer/scrape_notion.py
```

Writes all articles to `data/raw/notion_articles/notion_kb_export.json` (schema: `id`, `title`, `content`, `page_ref`).

**Step 2 — Index** (run after scraping, or whenever re-indexing is needed):

```bash
cd data-pipeline
uv run python indexer/build_index.py
```

Reads all `*.json` files from `data/raw/notion_articles/`, generates embeddings, and bulk-loads into OpenSearch.

```
Notion → scrape_notion.py → data/raw/notion_articles/*.json → build_index.py → OpenSearch
```

The indexer is idempotent — it deletes and recreates the index on each run. `data/raw/notion_articles/` is git-ignored.

### Querying (runtime, TypeScript)

```
ticketDescription → getKnowledgeBaseContext()
                     ├── embedQuery()   → POST /embed → 512-dim vector
                     ├── bm25Search()   → OpenSearch multi_match
                     │
                     │   (parallel via Promise.all)
                     │
                     ├── knnSearch()    → OpenSearch knn query
                     └── rrf()          → merge + sort → top 3 → XML → system prompt
```

The returned string is injected verbatim into the **Bedrock system prompt** (see `src/services/bedrock.ts:38-40`). XML tags (`<article>`, `<title>`, `<content>`) are used intentionally — they act as semantic delimiters that help Claude distinguish article boundaries reliably, without ambiguity that plain text separators could cause.

Implementation: `src/services/opensearch.ts`

## Debug Output

When `DEBUG=true`, the search logs a rank comparison table:

```
  BM25   kNN    RRF score   title
  ────────────────────────────────────────────────────────
  #1     #2     0.0323      Search result 1
  #3     #1     0.0321      Search result 2
    —    #3     0.0159      Search result 3
```

This shows how each article ranked in each retrieval method and the final fused score.

## OpenSearch Configuration

The cluster runs locally via Docker Compose (`docker-compose.yml`):

- **Image:** `opensearchproject/opensearch:2.11.0`
- **Port:** `9200`
- **`max_clause_count`:** `4096` (raised from the default 1024 to support `multi_match` across 7 fields with long ticket descriptions)

### Troubleshooting

**Verify the index exists and has documents:**

```bash
curl -s "http://localhost:9200/support-cli-kb/_count" | python3 -m json.tool
```

**Search for a specific article:**

```bash
curl -s "http://localhost:9200/support-cli-kb/_search?q=user" | python3 -m json.tool
```

**Check index mapping:**

```bash
curl -s "http://localhost:9200/support-cli-kb/_mapping" | python3 -m json.tool
```

**Check cluster settings (verify max_clause_count):**

```bash
curl -s "http://localhost:9200/_cluster/settings?include_defaults=true" \
  | python3 -m json.tool | grep max_clause
```
