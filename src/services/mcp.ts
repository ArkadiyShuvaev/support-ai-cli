import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getServerTransportParams } from './mcp_config';

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Reads the root mcp-servers.json file and extracts a high-level summary
 * of the connected systems to guide the LLM's planning phase.
 */
export async function getAvailableSystemsContext(): Promise<string> {
  try {
    // Assuming the CLI is executed from the root support-cli folder
    const configPath = path.resolve(process.cwd(), 'mcp-servers.json');
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(fileContent);

    if (!parsed.servers) {
      return 'No external systems configured.';
    }

    const systems = Object.entries(parsed.servers).map(
      ([name, config]: [string, any]) => {
        const desc = config.description
          ? config.description
          : 'Integration server';
        return `- ${name.toUpperCase()}: ${desc}`;
      },
    );

    return systems.join('\n');
  } catch (error) {
    console.warn(
      '\n⚠️ [MCP] Could not read mcp-servers.json for system context.',
      error,
    );
    return 'System integrations unknown.';
  }
}

// ---------------------------------------------------------------------------
// isReadOnlyTool — returns true when a tool only reads data and requires no
// human approval before execution.
//
// MCP tool names are namespaced as "<server>__<verb>_<resource>" (e.g.
// "linear__get_issue", "sentry__find_projects"). Classification is based on
// the verb part only, so it works across all MCP servers without needing to
// hardcode server names.
// ---------------------------------------------------------------------------
const READ_ONLY_PREFIXES = ['get_', 'list_', 'search_', 'find_'];
const READ_ONLY_EXACT = new Set(['whoami']);

export function isReadOnlyTool(toolName: string): boolean {
  const verb = toolName.includes('__') ? toolName.split('__')[1] : toolName;
  return (
    READ_ONLY_EXACT.has(verb) ||
    READ_ONLY_PREFIXES.some((p) => verb.startsWith(p))
  );
}

export async function executeMcpTool(
  namespacedName: string,
  input: any,
): Promise<any> {
  console.log(`\n⚙️  [MCP] Routing execution for '${namespacedName}'...`);

  // 1. Parse the namespace (e.g., "sentry__search_issues" -> server: "sentry", tool: "search_issues")
  const parts = namespacedName.split('__');

  // Fallback for your local mock tools (if you still want to test them before migrating)
  if (parts.length !== 2) {
    console.warn(
      `⚠️ Tool '${namespacedName}' has no namespace prefix. Assuming local mock.`,
    );
    return executeMockTool(namespacedName, input);
  }

  const [serverName, actualToolName] = parts;

  // 2. Get connection params from your mcp-servers.json config
  let transportParams;
  try {
    transportParams = getServerTransportParams(serverName);
  } catch (error) {
    throw new Error(
      `No MCP server configuration found for prefix: '${serverName}'. Update mcp-servers.json.`,
    );
  }

  // 3. Initialize the MCP Client
  const transport = new StdioClientTransport(transportParams);
  const client = new Client(
    { name: 'support-cli-router', version: '1.0.0' },
    { capabilities: {} },
  );

  // 4. Connect, Execute, and Parse
  try {
    await client.connect(transport);

    console.log(
      `  🔌 Connected to '${serverName}' server. Calling '${actualToolName}'...`,
    );
    const response = await client.callTool({
      name: actualToolName,
      arguments: input,
    });

    // Extract the text content from the MCP response
    const content = response.content as Array<{ type: string; text?: string }>;
    const rawText = content.find((c) => c.type === 'text')?.text ?? '{}';

    // Attempt to parse it as JSON, otherwise return the raw string
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  } catch (error) {
    console.error(
      `\n❌ [MCP] Failed to execute '${actualToolName}' on '${serverName}':`,
      error,
    );
    throw error;
  } finally {
    // 5. Always close the connection
    await client.close().catch(() => {});
  }
}

// Keep your old switch statement here temporarily just in case you
// need to test something locally without spinning up a real server.
async function executeMockTool(name: string, input: any): Promise<any> {
  // ... paste your existing switch(name) statement here ...
  return { status: 'mock_success', tool: name };
}
