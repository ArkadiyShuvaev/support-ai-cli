from __future__ import annotations

import asyncio
import os
import re
import json

from dotenv import find_dotenv, load_dotenv
from mcp import ClientSession
from mcp.client.stdio import stdio_client

from shared.logger import get_logger, make_subprocess_errlog
from shared.mcp_client import (
    call_tool as _call_tool,
    call_tool_with_retry as _call_tool_with_retry,
    load_server_params,
)

logger = get_logger(__name__, log_file="scrape_notion")

load_dotenv(find_dotenv())

_NOTION_KB_URL: str = os.environ.get("NOTION_KB_URL", "65f766e006d24604b5f6727215823f5b")
_NOTION_SEARCH_PAGE_SIZE: int = 25

_DATA_DIR: str = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "notion_articles")


def _extract_page_id(url_or_id: str) -> str:
    """Extracts the 32-char hex UUID from a Notion URL or returns the ID if already clean."""
    match = re.search(r"([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", url_or_id)
    return match.group(1).replace("-", "") if match else url_or_id


def _slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:64]


def parse_page(raw: str, page_ref: str, parent_db_id: str) -> dict | None:
    # 1. Strict Verification: Ensure the page actually belongs to the KB database
    if parent_db_id not in raw:
        logger.info("⏭️  Skipped (Outside of KB Database): %s", page_ref)
        return None

    text = raw
    title = ""
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and "text" in data:
            title = data.get("title", "")
            full_text = data["text"]
            content_match = re.search(r"<content>(.*?)</content>", full_text, re.DOTALL)
            text = content_match.group(1) if content_match else full_text
    except (json.JSONDecodeError, TypeError):
        pass

    if not title:
        title_match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        if not title_match:
            return None
        title = title_match.group(1).strip()

    return {
        "id":       _slug(title),
        "title":    title,
        "content":  text.strip(),
        "page_ref": page_ref,
    }

async def _fetch_categories(session: ClientSession, parent_page_id: str) -> list[str]:
    """Extracts Options from Feature, Scope, and Topic to cast the widest search net."""
    logger.info("⚙️  Fetching database schema to determine search categories...")
    raw = await _call_tool(session, "notion-fetch", {"id": parent_page_id})

    match = re.search(r"<data-source-state>\s*(.*?)\s*</data-source-state>", raw, re.DOTALL)
    if not match:
        logger.warning("⚠️ Could not find <data-source-state> in the KB page.")
        return []

    try:
        raw_state = match.group(1).strip()
        if "\\\"" in raw_state or "\\n" in raw_state:
            raw_state = raw_state.replace('\\"', '"').replace('\\n', '\n')

        start_idx = raw_state.find('{')
        end_idx = raw_state.rfind('}')
        if start_idx != -1 and end_idx != -1:
            raw_state = raw_state[start_idx:end_idx+1]

        state_json = json.loads(raw_state)
        schema = state_json.get("schema", {})

        categories = set()

        # Grab all options across multiple properties to ensure no page is missed
        for prop_name in ["Feature", "Scope", "Topic"]:
            options = schema.get(prop_name, {}).get("options", [])
            for opt in options:
                if opt.get("name"):
                    categories.add(opt.get("name"))

        logger.info("✅ Dynamically loaded %d total search vectors from Notion.", len(categories))
        return list(categories)

    except Exception as e:
        logger.warning("⚠️ Failed to parse data-source-state JSON: %s", e)
        return []


async def _search_page_refs(session: ClientSession, parent_page_id: str, category: str) -> list[str]:
    """Calls notion-search for a single category and returns matching page IDs."""
    search_args = {
        "query": category,
        "query_type": "internal",
        "page_url": parent_page_id,
        "page_size": _NOTION_SEARCH_PAGE_SIZE,
    }
    raw = await _call_tool_with_retry(session, "notion-search", search_args)
    response_json = json.loads(raw)
    results = response_json.get("results", [])
    return [_extract_page_id(item["id"]) for item in results if item.get("type") == "page" and item.get("id")]


async def _scrape() -> list[dict]:
    articles: list[dict] = []
    parent_id = _extract_page_id(_NOTION_KB_URL)

    errlog = make_subprocess_errlog(logger)
    async with stdio_client(load_server_params("notion"), errlog=errlog) as (read, write):
        errlog.close_write_end()
        async with ClientSession(read, write) as session:
            await session.initialize()
            logger.info("✅ Connected to Notion MCP")

            categories = await _fetch_categories(session, parent_id)

            if not categories:
                logger.error("❌ No categories found to chunk searches. Exiting.")
                return []

            # ⏳ RATE LIMIT PROTECTION
            await asyncio.sleep(2.0)

            logger.info("🔎 Searching inside parent page: %s", parent_id)
            seen: set[str] = set()
            for category in categories:
                try:
                    page_ids = await _search_page_refs(session, parent_id, category)
                    logger.info("  -> Category '%s': Found %d pages", category, len(page_ids))
                    seen.update(page_ids)
                except Exception as e:
                    logger.warning("⚠️ Failed searching category '%s': %s", category, e)
                # ⏳ RATE LIMIT PROTECTION: Wait 2 seconds before the next search
                await asyncio.sleep(2.0)

            page_refs = list(seen)
            logger.info("✅ Total unique pages discovered: %d", len(page_refs))

            logger.info("📥 Beginning full Markdown fetch...")
            for idx, page_ref in enumerate(page_refs, 1):
                try:
                    raw = await _call_tool_with_retry(session, "notion-fetch", {"id": page_ref})
                    article = parse_page(raw, page_ref, parent_id)

                    if article is None:
                        continue

                    articles.append(article)
                    logger.info("  ✅ Fetched [%d/%d]: %s", idx, len(page_refs), article["title"])

                except Exception as exc:
                    logger.error("  ❌ Permanently failed on %s: %s", page_ref, exc)

                # ⏳ RATE LIMIT PROTECTION: Wait 1.5 seconds between fetching pages
                await asyncio.sleep(1.5)

    return articles


def get_articles() -> list[dict]:
    try:
        articles = asyncio.run(_scrape())
        if not articles:
            logger.warning("⚠️  No articles met the criteria.")
        return articles
    except Exception as exc:
        logger.error("⚠️  Notion MCP unavailable: %s", exc)
        return []


if __name__ == "__main__":
    import shutil
    import sys

    articles = get_articles()

    if not articles:
        logger.error("No articles found.")
        sys.exit(1)

    logger.info("─" * 60)
    logger.info("  %d article(s) loaded", len(articles))
    logger.info("─" * 60)

    os.makedirs(_DATA_DIR, exist_ok=True)
    output_path = os.path.join(_DATA_DIR, "notion_kb_export.json")

    if os.path.exists(output_path):
        shutil.copy2(output_path, output_path + ".bkp")
        logger.info("📦 Backed up previous export to %s.bkp", output_path)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(articles, f, indent=2, ensure_ascii=False)

    logger.info("💾 Successfully exported articles to %s", output_path)
