"""MCP Schema Indexer — embeds MCP tool schemas and pushes them to OpenSearch.

This populates the `support-cli-tools` index used by the TS orchestrator in Phase 1c
(Step 6 of the README flow diagram): semantic + BM25 search over MCP tools
so the agent can discover which tools are relevant to its investigation plan.

Usage (from the data-pipeline/ directory):
    uv run python indexer/build_schema_index.py

Prerequisites:
    - OpenSearch running on OPENSEARCH_URL (default http://localhost:9200)
    - Embedding server running on EMBEDDING_SERVER_URL (default http://localhost:8001)
    - JSON schema files in data/raw/mcp_schemas/ (produced by scrape_mcp_schemas.py)
    - .env file at the project root with OPENSEARCH_URL, SCHEMA_INDEX_NAME, EMBEDDING_MODEL_NAME
"""

from __future__ import annotations

import glob
import json
import os
import sys

from dotenv import find_dotenv, load_dotenv
from sentence_transformers import SentenceTransformer

from shared.opensearch_helpers import bulk_index, create_client, recreate_index, wait_for_opensearch

load_dotenv(find_dotenv())

SCHEMA_INDEX_NAME: str = os.environ.get("SCHEMA_INDEX_NAME", "support-cli-tools")
EMBEDDING_MODEL_NAME: str = os.environ.get(
    "EMBEDDING_MODEL_NAME", "distiluse-base-multilingual-cased-v1"
)

SCHEMAS_DIR: str = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "mcp_schemas")

# ---------------------------------------------------------------------------
# Index mapping — hybrid kNN vector + BM25 text, same architecture as support-cli-kb.
# Each document represents one MCP tool from one server.
# ---------------------------------------------------------------------------
SCHEMA_INDEX_MAPPING: dict = {
    "settings": {
        "index": {
            "knn": True,
            "knn.algo_param.ef_search": 100,
        }
    },
    "mappings": {
        "properties": {
            "id":     {"type": "keyword"},
            "server": {"type": "keyword"},
            "name": {
                "type": "text", "analyzer": "standard", "boost": 3,
                "fields": {"keyword": {"type": "keyword"}},
            },
            "description": {
                "type": "text", "analyzer": "english",
            },
            # Raw JSON string of the inputSchema — lets BM25 match parameter names.
            "input_schema_json": {"type": "text"},
            "embedding": {
                "type":      "knn_vector",
                "dimension": 512,
                "method": {
                    "name":       "hnsw",
                    "engine":     "nmslib",
                    "space_type": "cosinesimil",
                    "parameters": {"ef_construction": 128, "m": 16},
                },
            },
        }
    },
}


def _load_tool_documents() -> list[dict]:
    """Load all tool schemas from data/schemas/*.json into flat document dicts."""
    schema_files = sorted(glob.glob(os.path.join(SCHEMAS_DIR, "*.json")))
    if not schema_files:
        print(f"❌ No schema files found in {SCHEMAS_DIR}", file=sys.stderr)
        print("   Run scrape_mcp_schemas.py first.", file=sys.stderr)
        sys.exit(1)

    documents: list[dict] = []
    for path in schema_files:
        server_name = os.path.splitext(os.path.basename(path))[0]
        print(f"  → Processing {os.path.basename(path)}")
        with open(path, encoding="utf-8") as f:
            schemas: dict[str, dict] = json.load(f)

        for tool_name, schema in schemas.items():
            documents.append(
                {
                    "id":               f"{server_name}__{tool_name}",
                    "server":           server_name,
                    "name":             tool_name,
                    "description":      schema.get("description") or "",
                    "input_schema_json": json.dumps(
                        schema.get("inputSchema") or {}, ensure_ascii=False
                    ),
                }
            )

    return documents


def main() -> None:
    # ------------------------------------------------------------------
    # Step 1 — Load tool documents from schema files.
    # ------------------------------------------------------------------
    documents = _load_tool_documents()
    servers = sorted({d["server"] for d in documents})
    print(f"📄 Loaded {len(documents)} tools from {len(servers)} server(s): {', '.join(servers)}")

    # ------------------------------------------------------------------
    # Step 2 — Load embedding model.
    # ------------------------------------------------------------------
    print(f"🤖 Loading model '{EMBEDDING_MODEL_NAME}'...")
    model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    print("✅ Model loaded (embedding dimension: 512)")

    # ------------------------------------------------------------------
    # Step 3 — Connect to OpenSearch.
    # ------------------------------------------------------------------
    client = create_client()
    wait_for_opensearch(client)

    # ------------------------------------------------------------------
    # Step 4 — Delete + recreate index.
    # ------------------------------------------------------------------
    recreate_index(client, SCHEMA_INDEX_NAME, SCHEMA_INDEX_MAPPING)

    # ------------------------------------------------------------------
    # Step 5 — Generate embeddings.
    # Embed "{name}: {description}" — concise signal focused on tool purpose.
    # ------------------------------------------------------------------
    print("🔢 Generating embeddings...")
    embed_texts = [
        f"{doc['name']}: {doc['description']}" for doc in documents
    ]
    embeddings = model.encode(
        embed_texts, show_progress_bar=True, normalize_embeddings=True
    )

    # ------------------------------------------------------------------
    # Step 6 — Bulk index.
    # ------------------------------------------------------------------
    actions = [
        {
            "_index": SCHEMA_INDEX_NAME,
            "_id":    doc["id"],
            "_source": {
                "id":               doc["id"],
                "server":           doc["server"],
                "name":             doc["name"],
                "description":      doc["description"],
                "input_schema_json": doc["input_schema_json"],
                "embedding":        embeddings[i].tolist(),
            },
        }
        for i, doc in enumerate(documents)
    ]

    bulk_index(client, actions)

    # ------------------------------------------------------------------
    # Step 7 — Verify.
    # ------------------------------------------------------------------
    client.indices.refresh(SCHEMA_INDEX_NAME)
    count = client.count(index=SCHEMA_INDEX_NAME)["count"]
    if count != len(documents):
        print(
            f"❌ Verification failed: expected {len(documents)}, got {count}",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"✅ Verification passed: {count} tool documents in '{SCHEMA_INDEX_NAME}'")


if __name__ == "__main__":
    main()
