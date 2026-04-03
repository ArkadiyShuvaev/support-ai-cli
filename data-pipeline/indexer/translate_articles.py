"""
translate_articles.py — Detect and translate French sentences in Notion KB articles.

Reads:  data/interim/notion_articles/notion_kb_filtered.json
Writes: data/interim/notion_articles/notion_kb_translated.json

Strategy: AWS Bedrock (Converse API) per article.
- LLM identifies French sentences and returns a list of {origin, translated} pairs.
- Articles with no French text get an empty translations list.
- Output is intended for manual review and in-place replacement.
"""

from __future__ import annotations

import json
import os
import boto3

from dotenv import find_dotenv, load_dotenv

from shared.logger import get_logger

logger = get_logger(__name__, log_file="translate_articles")

load_dotenv(find_dotenv())

_INTERIM_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "interim", "notion_articles")
_IN_PATH = os.path.join(_INTERIM_DIR, "notion_kb_filtered.json")
_OUT_PATH = os.path.join(_INTERIM_DIR, "notion_kb_translated.json")

_AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
_MODEL_ID = os.environ.get("AWS_MODEL_TRANSLATION_ID", "eu.amazon.nova-lite-v1:0")

_SYSTEM_PROMPT = (
    "You are a technical translator. Your only task is to identify French text and translate it to English.\n"
    "Rules:\n"
    "1. Find every sentence or phrase written in French in the input.\n"
    "2. For each French passage, produce one JSON object with two keys:\n"
    '   - "origin": the original French text, copied exactly as it appears.\n'
    '   - "translated": the English translation.\n'
    "3. Return ONLY a JSON array of these objects — no prose, no markdown fences, no extra keys.\n"
    "4. Skip HTML/XML-like tags, SQL/code blocks, URLs, and any text already in English.\n"
    "5. If there is NO French text in the input, return an empty JSON array: []\n"
    "Example output:\n"
    '[{"origin": "Bonjour le monde", "translated": "Hello world"}]'
)


def _extract_translations(client, content: str) -> list[dict]:
    """
    Call Bedrock to extract French→English translation pairs from `content`.
    Returns a list of {"origin": ..., "translated": ...} dicts (empty if no French found).
    """
    response = client.converse(
        modelId=_MODEL_ID,
        system=[{"text": _SYSTEM_PROMPT}],
        messages=[{"role": "user", "content": [{"text": content}]}],
        inferenceConfig={"maxTokens": 4096, "temperature": 0.1},
    )

    output_blocks = response.get("output", {}).get("message", {}).get("content", [])
    raw = next((b["text"] for b in output_blocks if "text" in b), "[]")

    try:
        pairs = json.loads(raw)
        if isinstance(pairs, list):
            return pairs
    except json.JSONDecodeError:
        logger.warning("Could not parse Bedrock response as JSON: %s", raw[:200])

    return []


def main() -> None:
    with open(_IN_PATH, encoding="utf-8") as f:
        articles: list[dict] = json.load(f)

    logger.info("📖 Loaded %d articles from %s", len(articles), _IN_PATH)

    client = boto3.client("bedrock-runtime", region_name=_AWS_REGION)

    translated_articles: list[dict] = []
    changed_count = 0

    for idx, article in enumerate(articles, 1):
        title = article.get("title", "")
        content = article.get("content", "")

        try:
            translations = _extract_translations(client, content)
        except Exception as exc:
            logger.error("[%3d/%d] %s ... ❌ FAILED: %s", idx, len(articles), title[:60], exc)
            translated_articles.append({**article, "translations": []})
            continue

        if translations:
            changed_count += 1
            logger.info("[%3d/%d] %s ... ✅ %d pair(s) found", idx, len(articles), title[:60], len(translations))
        else:
            logger.info("[%3d/%d] %s ... ⏭  no French detected", idx, len(articles), title[:60])

        translated_articles.append({**article, "translations": translations})

    os.makedirs(_INTERIM_DIR, exist_ok=True)
    with open(_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(translated_articles, f, indent=2, ensure_ascii=False)

    logger.info("💾 Saved %d articles to %s", len(translated_articles), _OUT_PATH)
    logger.info("   %d article(s) had French content detected.", changed_count)


if __name__ == "__main__":
    main()
