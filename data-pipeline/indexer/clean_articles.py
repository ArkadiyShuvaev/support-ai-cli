import json
import os
import re

from shared.logger import get_logger

logger = get_logger(__name__, log_file="clean_articles")

# Define relative paths based on your pipeline structure
RAW_DIR = os.path.join("data", "raw", "notion_articles")
INTERIM_DIR = os.path.join("data", "interim", "notion_articles")
INPUT_FILE = os.path.join(RAW_DIR, "notion_kb_export.json")
OUTPUT_FILE = os.path.join(INTERIM_DIR, "notion_kb_cleaned.json")
EXCLUDED_IDS_FILE = os.path.join(os.path.dirname(__file__), "..", "excluded_page_refs.txt")

# Exact strings from the Notion template to strip out
BOILERPLATE_STRINGS = [
    '<callout icon="🚫" color="gray_bg">',
    '<callout icon="✅" color="gray_bg">',
    '<callout icon="🗒️" color="gray_bg">',
    '</callout>',
    '<empty-block/>',
    '**What\'s not working/What are you trying to do<br>**Provide as much information as possible to clearly explain the issue or describe the process, including screenshots or screen recordings if available.',
    '**Resolution<br>**How to solve the issue',
    '**Helpers<br>**Any information that could help identify or resolve a similar issue (mostly questions to ask to the requester)'
]


def _load_excluded_ids() -> set[str]:
    if not os.path.exists(EXCLUDED_IDS_FILE):
        return set()
    with open(EXCLUDED_IDS_FILE, encoding="utf-8") as f:
        return {
            line.strip()
            for line in f
            if line.strip() and not line.startswith("#")
        }


def clean_boilerplate(text: str) -> str:
    """Removes Notion template boilerplate and cleans up formatting."""
    clean_text = text

    # 1. Remove exact boilerplate strings
    for bp in BOILERPLATE_STRINGS:
        clean_text = clean_text.replace(bp, "")

    # 2. Clean up excessive newlines/tabs left behind by the removed tags
    clean_text = re.sub(r'\t+', '', clean_text)
    clean_text = re.sub(r'\n{3,}', '\n\n', clean_text)

    return clean_text.strip()


def filter_and_clean_pages():
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
    cleaned_articles = []

    # 3. Filter out the empty and manually excluded pages, and clean the rest
    logger.info("🧹 Filtering empty pages and cleaning boilerplate...")
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

        # Clean the content and update the article dictionary
        cleaned_content = clean_boilerplate(content)

        # Failsafe: If the page ONLY contained boilerplate and is now empty, skip it
        if not cleaned_content:
            logger.info("  ⏭️  Removed page (only contained boilerplate): %s", article.get("title", "Unknown"))
            continue

        article["content"] = cleaned_content
        cleaned_articles.append(article)

    # 4. Save the cleaned data to the interim folder
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(cleaned_articles, f, indent=2, ensure_ascii=False)

    logger.info("✅ Cleaning complete!")
    logger.info("📊 Processed %d articles -> Kept %d valid, sanitized articles.", initial_count, len(cleaned_articles))
    logger.info("💾 Saved clean dataset to %s", OUTPUT_FILE)


if __name__ == "__main__":
    filter_and_clean_pages()
