"""
KB Indexer — embeds Notion KB articles and pushes them to a local OpenSearch cluster.

Usage (from the data-pipeline/ directory):
    uv run python indexer/build_index.py

Prerequisites:
    - OpenSearch running on OPENSEARCH_URL (default http://localhost:9200)
    - .env file at the project root with OPENSEARCH_URL, INDEX_NAME, EMBEDDING_MODEL_NAME
    - JSON article files in data/raw/notion_articles/ (produced by scrape_notion.py)
"""

from __future__ import annotations

import glob
import json
import os
import sys

from dotenv import find_dotenv, load_dotenv
from sentence_transformers import SentenceTransformer

from shared.opensearch_helpers import bulk_index, create_client, recreate_index, wait_for_opensearch

# ---------------------------------------------------------------------------
# Resolve .env from project root (one level above data-pipeline/).
# ---------------------------------------------------------------------------
load_dotenv(find_dotenv())

INDEX_NAME: str = os.environ.get("INDEX_NAME", "support-cli-kb")
EMBEDDING_MODEL_NAME: str = os.environ.get(
    "EMBEDDING_MODEL_NAME", "distiluse-base-multilingual-cased-v1"
)

DATA_DIR: str = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "notion_articles")

# ---------------------------------------------------------------------------
# Index mapping — hybrid kNN vector + BM25 text.
# ---------------------------------------------------------------------------
INDEX_MAPPING: dict = {
    "settings": {
        "index": {
            "knn": True,
            "knn.algo_param.ef_search": 100,
        }
    },
    "mappings": {
        "properties": {
            "id":       {"type": "keyword"},
            "title": {
                "type": "text", "analyzer": "standard", "boost": 3,
                "fields": {
                    "fr": {"type": "text", "analyzer": "french"},
                    "en": {"type": "text", "analyzer": "english"},
                },
            },
            "content": {
                "type": "text", "analyzer": "standard",
                "fields": {
                    "fr": {"type": "text", "analyzer": "french"},
                    "en": {"type": "text", "analyzer": "english"},
                },
            },
            "page_ref": {"type": "keyword"},
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


def _load_articles() -> list[dict]:
    articles: list[dict] = []
    json_files = sorted(glob.glob(os.path.join(DATA_DIR, "*.json")))
    if not json_files:
        print(f"❌ No JSON files found in {DATA_DIR}", file=sys.stderr)
        sys.exit(1)
    for path in json_files:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            articles.extend(data)
        else:
            articles.append(data)
    return articles


def main() -> None:
    # ------------------------------------------------------------------
    # Step 1 — Load articles from local data files.
    # ------------------------------------------------------------------
    articles = _load_articles()
    print(f"📄 Loaded {len(articles)} articles from {DATA_DIR}")

    # ------------------------------------------------------------------
    # Step 2 — Load embedding model.
    # ------------------------------------------------------------------
    print(f"🤖 Loading model '{EMBEDDING_MODEL_NAME}' (first run downloads ~260 MB)...")
    model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    print(f"✅ Model loaded (embedding dimension: 512)")

    # ------------------------------------------------------------------
    # Step 3 — Connect to OpenSearch.
    # ------------------------------------------------------------------
    client = create_client()
    wait_for_opensearch(client)

    # ------------------------------------------------------------------
    # Step 4 — Delete + recreate index.
    # ------------------------------------------------------------------
    recreate_index(client, INDEX_NAME, INDEX_MAPPING)

    # ------------------------------------------------------------------
    # Step 5 — Generate embeddings.
    # ------------------------------------------------------------------
    print("🔢 Generating embeddings...")
    texts = [article["content"] for article in articles]
    embeddings = model.encode(texts, show_progress_bar=True, normalize_embeddings=True)

    # ------------------------------------------------------------------
    # Step 6 — Bulk index.
    # ------------------------------------------------------------------
    actions = [
        {
            "_index": INDEX_NAME,
            "_id":    article["id"],
            "_source": {
                "id":        article["id"],
                "title":     article["title"],
                "content":   article["content"],
                "page_ref":  article["page_ref"],
                "embedding": embeddings[i].tolist(),
            },
        }
        for i, article in enumerate(articles)
    ]

    bulk_index(client, actions)

    # ------------------------------------------------------------------
    # Step 7 — Verify.
    # ------------------------------------------------------------------
    client.indices.refresh(INDEX_NAME)
    count = client.count(index=INDEX_NAME)["count"]
    if count != len(articles):
        print(f"❌ Verification failed: expected {len(articles)}, got {count}", file=sys.stderr)
        sys.exit(1)
    print(f"✅ Verification passed: {count} documents in '{INDEX_NAME}'")


if __name__ == "__main__":
    main()
