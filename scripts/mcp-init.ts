#!/usr/bin/env ts-node
/**
 * MCP connection initializer.
 *
 * Reads mcp-servers.json and connects to each server in turn.
 * For OAuth-based servers (Linear, Notion) the mcp-remote package
 * automatically opens a browser where the user approves access.
 * For token-based servers (GitHub, GCP) it first checks that all
 * required env vars referenced in the config are present.
 *
 * Run with: yarn mcp:init
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { config as loadDotenv } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

loadDotenv({ path: path.join(__dirname, '..', '.env') });

const MCP_CONFIG_PATH = path.join(__dirname, '..', 'mcp-servers.json');

// ---------------------------------------------------------------------------
// Config types (mirrors mcp_config.ts)
// ---------------------------------------------------------------------------

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
}

interface McpServersFile {
  servers: Record<string, McpServerEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readConfig(): McpServersFile {
  if (!fs.existsSync(MCP_CONFIG_PATH)) {
    console.error(`mcp-servers.json not found at ${MCP_CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(
    fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'),
  ) as McpServersFile;
}

/**
 * Resolves ${VAR} placeholders in the env block from process.env.
 * Returns the resolved map and a list of any variable names that were missing.
 */
function resolveEnvBlock(envBlock: Record<string, string>): {
  resolved: Record<string, string>;
  missing: string[];
} {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, val] of Object.entries(envBlock)) {
    const match = val.match(/^\$\{(.+)\}$/);
    if (match) {
      const varName = match[1];
      const envValue = process.env[varName];
      if (envValue) {
        resolved[key] = envValue;
      } else {
        missing.push(`${key} → $${varName}`);
      }
    } else {
      resolved[key] = val;
    }
  }

  return { resolved, missing };
}

function pause(rl: readline.Interface, prompt: string): Promise<void> {
  return new Promise((resolve) => rl.question(prompt, () => resolve()));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = readConfig();
  const entries = Object.entries(config.servers);

  console.log('\nMCP Connection Initializer');
  console.log('==========================');
  console.log(
    `Servers in mcp-servers.json: ${entries.map(([n]) => n).join(', ')}\n`,
  );
  console.log('OAuth servers (Linear, Notion) will open a browser window.');
  console.log(
    'Log in and click Allow / Continue / Trust to complete the handshake.\n',
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const results: Array<{
    name: string;
    status: 'ok' | 'skip' | 'error';
    detail: string;
  }> = [];

  for (let i = 0; i < entries.length; i++) {
    const [name, entry] = entries[i];

    console.log(`[ ${i + 1}/${entries.length} ]  ${name.toUpperCase()}`);
    if (entry.description) console.log(`           ${entry.description}`);

    // Resolve env block; skip if any required var is missing or empty
    let resolvedEnv: Record<string, string> | undefined;
    if (entry.env && Object.keys(entry.env).length > 0) {
      const { resolved, missing } = resolveEnvBlock(entry.env);
      if (missing.length > 0) {
        const varNames = missing.map((m) => m.split(' → ')[1]).join(', ');
        const detail = `missing credentials: ${missing.join(', ')}`;
        console.log(
          `\x1b[33m           ⚠  Token required — set ${varNames} in .env\x1b[0m`,
        );
        console.log(
          `           Skipping — re-run yarn mcp:init once the token is added.\n`,
        );
        results.push({ name, status: 'skip', detail });
        continue;
      }
      resolvedEnv = resolved;
    }

    console.log('           Connecting… (browser may open)\n');

    // Merge resolved env vars with the current process environment so the
    // child process has a complete environment (same as StdioClientTransport default).
    const childEnv = resolvedEnv
      ? {
          ...(Object.fromEntries(
            Object.entries(process.env).filter(([, v]) => v !== undefined),
          ) as Record<string, string>),
          ...resolvedEnv,
        }
      : undefined;

    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      stderr: 'ignore', // suppress mcp-remote debug logs and shutdown AbortError noise
      ...(childEnv ? { env: childEnv } : {}),
    });

    const client = new Client(
      { name: 'support-cli-init', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const detail = `${tools.length} tool(s) available`;
      console.log(`           ✓ Connected — ${detail}\n`);
      results.push({ name, status: 'ok', detail });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`           ✗ Failed — ${msg}\n`);
      results.push({ name, status: 'error', detail: msg });
    } finally {
      await client.close().catch(() => {});
    }

    // Give the user a chance to finish with any browser tab before the next server
    if (i < entries.length - 1) {
      await pause(rl, '           Press Enter to continue to the next server…');
      console.log('');
    }
  }

  // Summary
  console.log('\n── Summary ──────────────────────────');
  for (const { name, status, detail } of results) {
    if (status === 'ok') {
      console.log(`  \x1b[32m✓\x1b[0m  ${name.padEnd(10)} ${detail}`);
    } else if (status === 'skip') {
      console.log(`  \x1b[33m⚠\x1b[0m  ${name.padEnd(10)} ${detail}`);
    } else {
      console.log(`  \x1b[31m✗\x1b[0m  ${name.padEnd(10)} ${detail}`);
    }
  }
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error('\nInit failed:', err);
  process.exit(1);
});
