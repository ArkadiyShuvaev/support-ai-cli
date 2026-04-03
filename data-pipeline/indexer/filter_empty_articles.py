import json
import os

from shared.logger import get_logger

logger = get_logger(__name__, log_file="filter_empty_articles")

# Define relative paths based on your pipeline structure
RAW_DIR = os.path.join("data", "raw", "notion_articles")
INTERIM_DIR = os.path.join("data", "interim", "notion_articles")
INPUT_FILE = os.path.join(RAW_DIR, "notion_kb_export.json")
OUTPUT_FILE = os.path.join(INTERIM_DIR, "notion_kb_filtered.json")
EXCLUDED_IDS_FILE = os.path.join(os.path.dirname(__file__), "..", "excluded_page_refs.txt")


def _load_excluded_ids() -> set[str]:
    if not os.path.exists(EXCLUDED_IDS_FILE):
        return set()
    with open(EXCLUDED_IDS_FILE, encoding="utf-8") as f:
        return {
            line.strip()
            for line in f
            if line.strip() and not line.startswith("#")
        }


def filter_empty_pages():
    # 1. Ensure the interim directory exists
    os.makedirs(INTERIM_DIR, exist_ok=True)

    # 2. Load the raw data
    if not os.path.exists(INPUT_FILE):
        logger.error("❌ Input file not found: %s", INPUT_FILE)
        return

    logger.info("📂 Loading raw data from %s...", INPUT_FILE)
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        articles = json.load(f)

    excluded_ids = _load_excluded_ids()
    if excluded_ids:
        logger.info("🚫 Loaded %d manually excluded page_ref(s) from %s", len(excluded_ids), EXCLUDED_IDS_FILE)

    initial_count = len(articles)
    filtered_articles = []

    # 3. Filter out the empty and manually excluded pages
    logger.info("🧹 Filtering empty and excluded pages...")
    for article in articles:
        content = article.get("content", "")
        page_ref = article.get("page_ref", "")

        if page_ref in excluded_ids:
            logger.info("  🚫 Excluded by ID: %s (%s)", article.get("title", "Unknown"), page_ref)
            continue

        # Check for the MCP server's explicit blank page tag
        if "<blank-page>" in content or "This page is blank and has no content." in content:
            logger.info("  ⏭️  Removed empty page: %s", article.get("title", "Unknown"))
            continue

        filtered_articles.append(article)

    # 4. Save the cleaned data to the interim folder
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(filtered_articles, f, indent=2, ensure_ascii=False)

    logger.info("✅ Filtering complete!")
    logger.info("📊 Processed %d articles -> Kept %d valid articles.", initial_count, len(filtered_articles))
    logger.info("💾 Saved clean dataset to %s", OUTPUT_FILE)

if __name__ == "__main__":
    filter_empty_pages()