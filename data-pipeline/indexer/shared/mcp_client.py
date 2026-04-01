"""Shared MCP client helpers.

Provides server parameter loading from mcp-servers.json and reusable
tool-call utilities (with exponential-backoff retry) used by all scraper scripts.
"""

from __future__ import annotations

import asyncio
import json
import os
import random

from dotenv import find_dotenv, load_dotenv
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

load_dotenv(find_dotenv())

# mcp-servers.json lives at the project root:
# shared/ -> indexer/ -> data-pipeline/ -> project root
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
_MCP_SERVERS_CONFIG = os.path.join(_PROJECT_ROOT, "mcp-servers.json")

_BACKOFF_BASE = 5.0
_BACKOFF_MAX = 120.0
_DEFAULT_MAX_RETRIES = 6


def load_server_params(server_name: str) -> StdioServerParameters:
    """Return StdioServerParameters for the named server from mcp-servers.json."""
    with open(_MCP_SERVERS_CONFIG, encoding="utf-8") as f:
        config = json.load(f)

    servers = config.get("servers", {})
    if server_name not in servers:
        raise KeyError(
            f"Server '{server_name}' not found in {_MCP_SERVERS_CONFIG}. "
            f"Available: {list(servers.keys())}"
        )

    server_cfg = servers[server_name]

    # Resolve ${ENV_VAR} placeholders in the env block.
    env: dict[str, str] = {}
    for key, val in server_cfg.get("env", {}).items():
        if isinstance(val, str) and val.startswith("${") and val.endswith("}"):
            env_var = val[2:-1]
            env[key] = os.environ.get(env_var, "")
        else:
            env[key] = str(val)

    return StdioServerParameters(
        command=server_cfg["command"],
        args=server_cfg["args"],
        env=env if env else None,
    )


def load_all_server_names() -> list[str]:
    """Return all server names defined in mcp-servers.json."""
    with open(_MCP_SERVERS_CONFIG, encoding="utf-8") as f:
        config = json.load(f)
    return list(config.get("servers", {}).keys())


async def call_tool(session: ClientSession, name: str, arguments: dict) -> str:
    """Call an MCP tool and return its text output."""
    result = await session.call_tool(name, arguments)
    return "\n".join(
        c.text for c in result.content if hasattr(c, "text") and c.text
    )


async def call_tool_with_retry(
    session: ClientSession,
    name: str,
    arguments: dict,
    max_retries: int = _DEFAULT_MAX_RETRIES,
) -> str:
    """Call an MCP tool with exponential-backoff retry on failure."""
    delay = _BACKOFF_BASE
    for attempt in range(max_retries + 1):
        try:
            return await call_tool(session, name, arguments)
        except Exception as exc:
            if attempt == max_retries:
                raise
            jitter = random.uniform(0, delay * 0.2)
            wait = min(delay + jitter, _BACKOFF_MAX)
            print(f"  ⚠️  Tool call failed (attempt {attempt + 1}/{max_retries}): {exc}")
            print(f"  ⏳ Retrying in {wait:.1f}s...")
            await asyncio.sleep(wait)
            delay = min(delay * 2, _BACKOFF_MAX)
    raise RuntimeError("Unreachable")  # satisfies type checkers
