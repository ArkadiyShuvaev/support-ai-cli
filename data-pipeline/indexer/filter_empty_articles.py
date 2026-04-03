import json
import os

from shared.logger import get_logger

logger = get_logger(__name__, log_file="filter_empty_articles")

# Define relative paths based on your pipeline structure
RAW_DIR = os.path.join("data", "raw", "notion_articles")
INTERIM_DIR = os.path.join("data", "interim", "notion_articles")
INPUT_FILE = os.path.join(RAW_DIR, "notion_kb_export.json")
OUTPUT_FILE = os.path.join(INTERIM_DIR, "notion_kb_filtered.json")

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

    initial_count = len(articles)
    filtered_articles = []

    # 3. Filter out the empty pages
    logger.info("🧹 Filtering empty pages...")
    for article in articles:
        content = article.get("content", "")

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