import { readFileSync } from 'fs';
import { join } from 'path';

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
}

interface McpServersFile {
  servers: Record<string, McpServerEntry>;
}

// mcp-servers.json lives at the project root, two levels above src/services/
const CONFIG_PATH = join(__dirname, '..', '..', 'mcp-servers.json');

let _config: McpServersFile | null = null;

function getConfig(): McpServersFile {
  if (!_config) {
    _config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as McpServersFile;
  }
  return _config;
}

export interface TransportParams {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Returns the transport parameters for a named MCP server from mcp-servers.json.
 * ${ENV_VAR} placeholders in the env block are resolved from process.env.
 */
export function getServerTransportParams(serverName: string): TransportParams {
  const { servers } = getConfig();
  const server = servers[serverName];
  if (!server) {
    throw new Error(
      `MCP server '${serverName}' not found in mcp-servers.json. ` +
        `Available: ${Object.keys(servers).join(', ')}`,
    );
  }

  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(server.env ?? {})) {
    if (val.startsWith('${') && val.endsWith('}')) {
      const envVar = val.slice(2, -1);
      env[key] = process.env[envVar] ?? '';
    } else {
      env[key] = val;
    }
  }

  return {
    command: server.command,
    args: server.args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
