"""Shared OpenSearch helpers.

Provides client creation, connection health-check, index lifecycle management,
and bulk indexing utilities reused by all indexer scripts.

OPENSEARCH_URL is read once from the environment here; callers do not need to
pass it around.
"""

from __future__ import annotations

import os
import sys
import time

from dotenv import find_dotenv, load_dotenv
from opensearchpy import OpenSearch
from opensearchpy.helpers import bulk as _os_bulk

load_dotenv(find_dotenv())

OPENSEARCH_URL: str = os.environ.get("OPENSEARCH_URL", "http://localhost:9200")


def create_client() -> OpenSearch:
    """Return a configured OpenSearch client using OPENSEARCH_URL from the environment."""
    return OpenSearch(
        hosts=[OPENSEARCH_URL],
        use_ssl=False,
        verify_certs=False,
        ssl_show_warn=False,
    )


def wait_for_opensearch(client: OpenSearch, retries: int = 10, delay: int = 2) -> None:
    """Block until OpenSearch is reachable, or exit with an error."""
    for attempt in range(1, retries + 1):
        try:
            if client.ping():
                print(f"✅ OpenSearch is reachable at {OPENSEARCH_URL}")
                return
        except Exception:
            pass
        print(f"⏳ Waiting for OpenSearch... (attempt {attempt}/{retries})")
        time.sleep(delay)
    print(
        f"❌ OpenSearch not reachable after {retries} attempts. Is docker-compose up?",
        file=sys.stderr,
    )
    sys.exit(1)


def recreate_index(client: OpenSearch, index_name: str, mapping: dict) -> None:
    """Delete (if exists) and recreate an index with the given mapping."""
    if client.indices.exists(index_name):
        client.indices.delete(index_name)
        print(f"🗑  Deleted existing index '{index_name}'")
    client.indices.create(index_name, body=mapping)
    print(f"📁 Created index '{index_name}'")


def bulk_index(client: OpenSearch, actions: list[dict]) -> int:
    """Bulk-index documents and return the success count."""
    success, errors = _os_bulk(client, actions)
    if errors:
        print(f"⚠️  Bulk index completed with errors: {errors}", file=sys.stderr)
    else:
        print(f"✅ Indexed {success} documents")
    return success
