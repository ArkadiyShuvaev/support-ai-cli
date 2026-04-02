# data-pipeline

Python indexing pipeline for the Support AI CLI. Scrapes KB articles from Notion and MCP tool
schemas from configured servers, generates embeddings, and pushes them to the local OpenSearch
cluster.

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) — `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Docker (OpenSearch must be running — see root `docker-compose.yml`)
- AWS credentials (`aws sso login` or standard profile) — required for embeddings

```bash
# Install dependencies (once)
uv sync
```

---

## KB Articles pipeline (`support-cli-kb` index)

### 1. Scrape — `indexer/scrape_notion.py`

Connects to Notion via MCP and exports all KB articles to `data/raw/notion_articles/notion_kb_export.json`.
Run this whenever Notion content changes.

```bash
uv run python indexer/scrape_notion.py
```

**Required `.env` variable:**

| Variable        | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `NOTION_KB_URL` | URL or ID of the Notion page/database containing KB articles |

---

### 2. Translate — `indexer/translate_articles.py` _(optional)_

Detects French sentences in the scraped articles and translates them to English in-place using
AWS Bedrock (Claude). Skip this step if the KB is already fully in English.

- **Input:** `data/raw/notion_articles/notion_kb_export.json`
- **Output:** `data/interim/notion_kb_translated.json`

Preserves all Notion markup, SQL/code blocks, URLs, and English text — only French passages are
replaced.

```bash
uv run python indexer/translate_articles.py
```

**Environment variables:**

| Variable        | Default                                    | Description                        |
| --------------- | ------------------------------------------ | ---------------------------------- |
| `AWS_REGION`    | `us-east-1`                                | AWS region for Bedrock             |
| `AWS_MODEL_ID`  | `anthropic.claude-haiku-4-5-20251001`      | Bedrock model used for translation |

---

### 3. Index — `indexer/build_index.py`

Reads `data/raw/notion_articles/*.json` (or `data/interim/notion_kb_translated.json` if you ran
the translate step), generates multilingual embeddings with
`distiluse-base-multilingual-cased-v1`, and bulk-loads into the `support-cli-kb` OpenSearch index.
Idempotent — deletes and recreates the index on each run.

```bash
uv run python indexer/build_index.py
```

Expected output:

```
📄 Loaded 7 articles from .../data/raw/notion_articles
🤖 Loading model 'distiluse-base-multilingual-cased-v1' (first run downloads ~260 MB)...
✅ Model loaded (embedding dimension: 512)
✅ OpenSearch is reachable at http://localhost:9200
🗑  Deleted existing index 'support-cli-kb'
📁 Created index 'support-cli-kb'
🔢 Generating embeddings...
Batches: 100%|████████████████| 1/1 [00:02<00:00]
✅ Indexed 7 documents
✅ Verification passed: 7 documents in 'support-cli-kb'
```

Spot-check a document:

```bash
curl -s "http://localhost:9200/support-cli-kb/_search?q=user" | python3 -m json.tool
```

---

## MCP Schemas pipeline (`support-cli-tools` index)

Used by the TS orchestrator at runtime (Step 6 of the flow diagram) to semantically match
the agent's investigation plan against available MCP tools.

### 4. Scrape — `indexer/scrape_mcp_schemas.py`

Connects to each MCP server listed in `mcp-servers.json` and saves all tool schemas to
`data/raw/mcp_schemas/{server_name}.json`.

```bash
uv run python indexer/scrape_mcp_schemas.py              # all servers
uv run python indexer/scrape_mcp_schemas.py --servers linear notion   # subset
```

---

### 5. Index — `indexer/build_schema_index.py`

Reads `data/raw/mcp_schemas/*.json`, generates embeddings, and bulk-loads into the
`support-cli-tools` OpenSearch index. Idempotent.

```bash
uv run python indexer/build_schema_index.py
```

---

## Infrastructure — `embedding_server.py`

Serves the SentenceTransformer model over HTTP so the TypeScript CLI can embed query text
for kNN search. Managed by `docker-compose` — no need to start manually.

```bash
# Only needed outside Docker (e.g. for local development)
uv run uvicorn embedding_server:app --port 8001 --reload
```

---

## Typical workflow

```bash
# 1. Start infrastructure (from project root)
docker-compose up -d
curl http://localhost:9200/_cluster/health   # wait for green/yellow

# 2. KB Articles — scrape, optionally translate, then index
uv run python indexer/scrape_notion.py
uv run python indexer/translate_articles.py  # optional: translate French → English
uv run python indexer/build_index.py

# 3. MCP Schemas — scrape then index
uv run python indexer/scrape_mcp_schemas.py
uv run python indexer/build_schema_index.py

# 4. Verify both indices
curl -s "http://localhost:9200/support-cli-kb/_count"    | python3 -m json.tool
curl -s "http://localhost:9200/support-cli-tools/_count" | python3 -m json.tool
```
