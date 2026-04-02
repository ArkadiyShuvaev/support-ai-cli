"""
translate_articles.py — Detect and translate French sentences in Notion KB articles.

Reads:  data/raw/notion_articles/notion_kb_export.json
Writes: data/interim/notion_kb_translated.json

Strategy: AWS Bedrock (Converse API) per article.
- LLM identifies French sentences and translates them to English in-place.
- Preserves all HTML-like markup, SQL/code blocks, URLs, and English text.
- Articles with no French text are passed through unchanged.
"""

from __future__ import annotations

import json
import os
import boto3

from dotenv import find_dotenv, load_dotenv

from shared.logger import get_logger

logger = get_logger(__name__, log_file="translate_articles")

load_dotenv(find_dotenv())

_RAW_PATH = os.path.join(
    os.path.dirname(__file__), "..", "data", "raw", "notion_articles", "notion_kb_export.json"
)
_INTERIM_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "interim")
_OUT_PATH = os.path.join(_INTERIM_DIR, "notion_kb_translated.json")

_AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
# _MODEL_ID = os.environ.get("AWS_MODEL_ID", "anthropic.claude-haiku-4-5-20251001")
_MODEL_ID = "anthropic.claude-haiku-4-5-20251001"

_SYSTEM_PROMPT = (
    "You are a technical translator. Your only task is to translate French text to English. "
    "Rules:\n"
    "1. Identify every sentence or phrase written in French.\n"
    "2. Replace each French passage with its English translation, in-place.\n"
    "3. Preserve ALL of the following exactly as-is: HTML/XML-like tags "
    "(e.g. <callout>, <empty-block>, <mention-user>), SQL code blocks, "
    "markdown code fences (```), URLs, and any text already in English.\n"
    "4. Do NOT add explanations, comments, or any wrapper around your output.\n"
    "5. If the input contains NO French text, return it completely unchanged.\n"
    "6. Output only the translated content — nothing else."
)


def _translate_content(client, content: str) -> tuple[str, bool]:
    """
    Call Bedrock to translate French portions of `content`.
    Returns (translated_content, was_changed).
    """
    response = client.converse(
        modelId=_MODEL_ID,
        system=[{"text": _SYSTEM_PROMPT}],
        messages=[{"role": "user", "content": [{"text": content}]}],
        inferenceConfig={"maxTokens": 4096, "temperature": 0.1},
    )

    output_blocks = response.get("output", {}).get("message", {}).get("content", [])
    translated = next(
        (b["text"] for b in output_blocks if "text" in b),
        content,  # fallback: return original if something goes wrong
    )

    was_changed = translated.strip() != content.strip()
    return translated, was_changed


def main() -> None:
    with open(_RAW_PATH, encoding="utf-8") as f:
        articles: list[dict] = json.load(f)

    logger.info("📖 Loaded %d articles from %s", len(articles), _RAW_PATH)

    client = boto3.client("bedrock-runtime", region_name=_AWS_REGION)

    translated_articles: list[dict] = []
    changed_count = 0

    for idx, article in enumerate(articles, 1):
        title = article.get("title", "")
        content = article.get("content", "")

        try:
            translated_content, was_changed = _translate_content(client, content)
        except Exception as exc:
            logger.error("[%3d/%d] %s ... ❌ FAILED: %s", idx, len(articles), title[:60], exc)
            translated_articles.append(article)
            continue

        if was_changed:
            changed_count += 1
            logger.info("[%3d/%d] %s ... ✅ translated", idx, len(articles), title[:60])
        else:
            logger.info("[%3d/%d] %s ... ⏭  no French detected", idx, len(articles), title[:60])

        translated_articles.append({**article, "content": translated_content})

    os.makedirs(_INTERIM_DIR, exist_ok=True)
    with open(_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(translated_articles, f, indent=2, ensure_ascii=False)

    logger.info("💾 Saved %d articles to %s", len(translated_articles), _OUT_PATH)
    logger.info("   %d article(s) had French content translated.", changed_count)


if __name__ == "__main__":
    main()
