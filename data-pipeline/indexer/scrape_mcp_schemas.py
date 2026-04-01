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
import sys
from argparse import ArgumentParser

from mcp import ClientSession
from mcp.client.stdio import stdio_client

from shared.mcp_client import load_all_server_names, load_server_params

_SCHEMAS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "mcp_schemas")


async def _fetch_schemas(server_name: str) -> dict[str, dict]:
    """Connect to a single MCP server and return all tool schemas."""
    server_params = load_server_params(server_name)
    print(f"🔌 Connecting to '{server_name}' MCP server...")

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print(f"  ✅ Connected. Fetching tool list...")

            tools_response = await session.list_tools()

            schemas: dict[str, dict] = {}
            for tool in tools_response.tools:
                schemas[tool.name] = {
                    "description": tool.description,
                    "inputSchema": tool.inputSchema,
                }

            print(f"  📦 Found {len(schemas)} tools on '{server_name}'")
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

            print(f"  💾 Saved to {output_path}\n")
            success_count += 1
        except Exception as exc:
            print(f"  ❌ Failed to scrape '{server_name}': {exc}\n", file=sys.stderr)

    print(f"{'─' * 60}")
    print(f"  {success_count}/{len(server_names)} server(s) scraped successfully.")
    print(f"{'─' * 60}")


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
    print(f"🎯 Scraping schemas for: {', '.join(server_names)}\n")

    asyncio.run(_scrape_all(server_names))


if __name__ == "__main__":
    main()
