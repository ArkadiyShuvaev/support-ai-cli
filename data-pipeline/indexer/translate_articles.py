"""
translate_articles.py — Detect and translate French sentences in Notion KB articles.

Reads:  data/interim/notion_articles/notion_kb_cleaned.json
Writes: data/interim/notion_articles/notion_kb_translated.json

Strategy: AWS Bedrock (Converse API) per article.
- LLM identifies French sentences and returns a list of {origin, translated} pairs.
- Only articles with French content are written to the output file.
- Output is intended for manual review and in-place replacement.

Resume support: the output file is written line-by-line (JSONL). If the script is interrupted,
re-running it reads the already-written IDs from the output file and skips those articles,
picking up from where it left off. To reprocess everything from scratch, delete the output file.
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
_IN_PATH = os.path.join(_INTERIM_DIR, "notion_kb_cleaned.jsonl")
_OUT_PATH = os.path.join(_INTERIM_DIR, "notion_kb_translated.jsonl")

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


def _extract_translations(client, title: str, content: str) -> list[dict]:
    """
    Call Bedrock to extract French→English translation pairs from `title` and `content`.
    Returns a list of {"origin": ..., "translated": ...} dicts (empty if no French found).
    """
    text = f"<title>{title}</title>\n<content>{content}</content>"
    response = client.converse(
        modelId=_MODEL_ID,
        system=[{"text": _SYSTEM_PROMPT}],
        messages=[{"role": "user", "content": [{"text": text}]}],
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


def _load_processed_ids(path: str) -> set[str]:
    """Return IDs of articles already written to the output file (for resume support)."""
    processed: set[str] = set()
    if not os.path.exists(path):
        return processed
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    obj = json.loads(line)
                    if "id" in obj:
                        processed.add(obj["id"])
                except json.JSONDecodeError:
                    pass
    return processed


def main() -> None:
    with open(_IN_PATH, encoding="utf-8") as f:
        articles: list[dict] = [json.loads(line) for line in f if line.strip()]

    logger.info("📖 Loaded %d articles from %s", len(articles), _IN_PATH)

    processed_ids = _load_processed_ids(_OUT_PATH)
    resuming = bool(processed_ids)
    if resuming:
        logger.info("⏩ Resuming — %d article(s) already processed, skipping.", len(processed_ids))

    client = boto3.client("bedrock-runtime", region_name=_AWS_REGION)

    os.makedirs(_INTERIM_DIR, exist_ok=True)
    total = len(articles)
    written_count = len(processed_ids)
    changed_count = 0

    with open(_OUT_PATH, "a" if resuming else "w", encoding="utf-8") as out:
        for idx, article in enumerate(articles, 1):
            article_id = article.get("id", "")
            title = article.get("title", "")

            if article_id in processed_ids:
                continue

            content = article.get("content", "")

            try:
                translations = _extract_translations(client, title, content)
            except Exception as exc:
                logger.error("[%3d/%d] %s ... ❌ FAILED: %s", idx, total, title[:60], exc)
                translations = []

            if translations:
                changed_count += 1
                logger.info("[%3d/%d] %s ... ✅ %d pair(s) found", idx, total, title[:60], len(translations))
                out.write(json.dumps({**article, "translations": translations}, ensure_ascii=False) + "\n")
                out.flush()
                written_count += 1
            else:
                logger.info("[%3d/%d] %s ... ⏭  no French detected", idx, total, title[:60])

    logger.info("💾 Saved %d article(s) with French content to %s", written_count, _OUT_PATH)


if __name__ == "__main__":
    main()
