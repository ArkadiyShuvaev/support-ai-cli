"""MCP Schema Scraper — connects to each configured MCP server and downloads all tool schemas.

Usage (from the data-pipeline/ directory):
    uv run python indexer/scrape_mcp_schemas.py                   # all servers
    uv run python indexer/scrape_mcp_schemas.py --servers linear notion

Outputs one JSON file per server to data/raw/mcp_schemas/{server_name}.json.
The JSON maps tool name -> { description, inputSchema }.
"""

from __future__ import annotations

import asyncio
import json
import os
from argparse import ArgumentParser

from mcp import ClientSession
from mcp.client.stdio import stdio_client

from shared.logger import get_logger, make_subprocess_errlog
from shared.mcp_client import load_all_server_names, load_server_params

logger = get_logger(__name__, log_file="scrape_mcp_schemas")

_SCHEMAS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "mcp_schemas")


async def _fetch_schemas(server_name: str) -> dict[str, dict]:
    """Connect to a single MCP server and return all tool schemas."""
    server_params = load_server_params(server_name)
    logger.info("🔌 Connecting to '%s' MCP server...", server_name)

    errlog = make_subprocess_errlog(logger)
    async with stdio_client(server_params, errlog=errlog) as (read, write):
        errlog.close_write_end()
        async with ClientSession(read, write) as session:
            await session.initialize()
            logger.info("  ✅ Connected. Fetching tool list...")

            tools_response = await session.list_tools()

            schemas: dict[str, dict] = {}
            for tool in tools_response.tools:
                schemas[tool.name] = {
                    "description": tool.description,
                    "inputSchema": tool.inputSchema,
                }

            logger.info("  📦 Found %d tools on '%s'", len(schemas), server_name)
            return schemas


async def _scrape_all(server_names: list[str]) -> None:
    os.makedirs(_SCHEMAS_DIR, exist_ok=True)

    success_count = 0
    for server_name in server_names:
        try:
            schemas = await _fetch_schemas(server_name)

            output_path = os.path.join(_SCHEMAS_DIR, f"{server_name}.json")
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(schemas, f, indent=2, ensure_ascii=False)

            logger.info("  💾 Saved to %s", output_path)
            success_count += 1
        except Exception as exc:
            logger.error("  ❌ Failed to scrape '%s': %s", server_name, exc)

    logger.info("─" * 60)
    logger.info("  %d/%d server(s) scraped successfully.", success_count, len(server_names))
    logger.info("─" * 60)


def main() -> None:
    parser = ArgumentParser(
        description="Download MCP tool schemas from configured servers to data/schemas/"
    )
    parser.add_argument(
        "--servers",
        nargs="*",
        metavar="SERVER",
        help="Server names to scrape (default: all from mcp-servers.json)",
    )
    args = parser.parse_args()

    server_names: list[str] = args.servers or load_all_server_names()
    logger.info("🎯 Scraping schemas for: %s", ", ".join(server_names))

    asyncio.run(_scrape_all(server_names))


if __name__ == "__main__":
    main()
