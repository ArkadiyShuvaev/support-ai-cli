# AI Agents & Models

This document describes the AWS Bedrock models used in this project and the rationale behind each choice.

---

## Support Agent — `AWS_MODEL_ID`

**Default:** `eu.amazon.nova-2-lite-v1:0`

Used by the TypeScript CLI (`src/services/bedrock.ts`) to run the interactive support-ticket resolution loop. This is the primary agent: it analyses tickets, plans investigations, calls MCP tools, and produces operator replies.

| Model | Notes |
| ----- | ----- |
| `eu.amazon.nova-2-lite-v1:0` | Default. Fast and cost-effective for multi-turn agentic workflows. |
| `eu.amazon.nova-pro-v1:0` | Higher reasoning quality; use for complex or ambiguous tickets. |

---

## Translation — `AWS_MODEL_TRANSLATION_ID`

**Default:** `eu.amazon.nova-lite-v1:0`

Used by the data-pipeline script (`data-pipeline/indexer/translate_articles.py`) to detect French sentences in Notion KB articles and produce English translations for manual review.

### Nova model comparison for translation

| Model | Speed | Cost | Translation quality | Recommendation |
| ----- | ----- | ---- | ------------------- | -------------- |
| `eu.amazon.nova-micro-v1:0` | Fastest | Lowest | Limited multilingual nuance | ⚠️ Not recommended — may miss idiomatic French |
| `eu.amazon.nova-lite-v1:0` | Fast | Low | Good French↔English fidelity | ✅ **Recommended default** |
| `eu.amazon.nova-pro-v1:0` | Moderate | Higher | Best quality | Overkill for batch KB translation |

Nova Lite is the right trade-off: it handles technical French (fintech jargon, mixed-language paragraphs) accurately without the cost of Pro.

---

## Region

All models use the `eu-central-1` region (`AWS_REGION`) with the `eu.` cross-region inference prefix, keeping data within the EU.

---

## Documentation Maintenance

After every update to models, prompts, tools, or agent behavior, decide whether the change is **major** and warrants updating this file.

**Major changes** (update this file):
- Updating existing functionality
- Adding new functions or tools (including MCP tools)
- Renaming files that affect imports, configuration, or agent wiring
- Changing environment variables that control agent behavior (`AWS_MODEL_ID`, `AWS_REGION`, etc.)
- Modifying the system prompt
- Adding or removing a model / agent role
- Changing the AWS region or inference prefix

**Minor changes** (no update needed):
- Prompt wording tweaks with no behavioral impact
- Internal refactors that don't affect model selection or agent logic
- Dependency or tooling upgrades unrelated to AI behavior
