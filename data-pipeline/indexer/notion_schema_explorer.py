import asyncio
import json
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def export_tool_schemas():
    # 💡 Replace the args below with your actual Notion MCP server command.
    # If using a remote server, it might be: ["-y", "mcp-remote", "https://your-notion-url"]
    # If using the official local package, it might be: ["-y", "@modelcontextprotocol/server-notion"]
    server_params = StdioServerParameters(
        command="npx",
        args=["-y", "mcp-remote", "https://mcp.notion.com/mcp"] 
    )

    print("Connecting to MCP server...")
    
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            
            print("Connected! Fetching tools...")
            tools_response = await session.list_tools()
            
            schema_export = {}
            for tool in tools_response.tools:
                schema_export[tool.name] = {
                    "description": tool.description,
                    "inputSchema": tool.inputSchema
                }
            
            # Write the complete schema dictionary to a JSON file
            output_filename = "notion_mcp_schemas.json"
            with open(output_filename, "w", encoding="utf-8") as f:
                json.dump(schema_export, f, indent=2, ensure_ascii=False)
            
            print(f"✅ Successfully exported {len(tools_response.tools)} tool schemas to '{output_filename}'")

if __name__ == "__main__":
    asyncio.run(export_tool_schemas())