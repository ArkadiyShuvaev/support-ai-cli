Here is a step-by-step implementation plan to move from stubs to a real working prototype:

### Step 1: The Brain (Real Bedrock + Mock Data)

**Goal:** Prove the `tool_use` loop works with Claude 3.

- Keep your OpenSearch stub (returning the fake French KB article).
- Keep your MCP stubs (returning fake BigQuery results).
- Update `src/services/bedrock.ts` to use your actual AWS credentials and call the real Bedrock `ConverseCommand`.
- **Success Criteria:** You pass a hardcoded ticket via the CLI, the real Claude 3 model reads your mock KB article, outputs a `tool_use` request for `execute_sql`, your CLI prompts you `[Y/n]`, and Claude finishes the loop after you approve.

### Step 2: The Memory (Real OpenSearch + Python Ingestion)

**Goal:** Give the AI real knowledge to pull from.

- Spin up your `docker-compose.yml` for OpenSearch 2.11.0.
- Switch to the `data-pipeline` folder. Write `build_index.py` using `sentence-transformers` (`distiluse-base-multilingual-cased-v1`) to embed a few real Notion articles and push them to OpenSearch.
- Update `src/services/opensearch.ts` to actually query localhost:9200.
- **Success Criteria:** You run the CLI, it fetches the real KB article from your local database, passes it to real Bedrock, and Bedrock successfully requests the mock tool.

### Step 3: The Hands (Real MCP Tools)

**Goal:** Let the AI actually execute diagnostic commands.

- Ditch the `executeMcpTool` stub in `src/services/mcp.ts`.
- Connect your CLI to actual local MCP servers (using `@modelcontextprotocol/sdk`).
- If you don't have MCP servers ready yet, write the real TypeScript functions to query BigQuery and hit the Postman/Backoffice API endpoints directly for now.
- **Success Criteria:** You approve the `[Y/n]` prompt, and your CLI actually runs a query against your dev database or pings a real API.

### Step 4: The Eyes (Real Linear Integration)

**Goal:** Automate the input.

- Only now should you worry about Linear.
- Instead of passing the ticket as a command-line argument (`process.argv[2]`), add a quick Linear API call to fetch tickets tagged with a specific label or project.
- **Success Criteria:** You type `npm start`, the CLI grabs the newest ticket from Linear, finds the KB article, asks Claude what to do, and prompts you to fix it.

## Step 5: Improvements

- Add a glossary (to the index?)
- Metabase connections to fetch obfuscated data for the AI to reason over.
- Slack messages to index and pull in as KB context.
- To consider: Exclude write MCP tools from the index (but how can Linear ticket be updated then?)
- Evaluate the embedding model harrier-oss-v1 (https://huggingface.co/microsoft/harrier-oss-v1-270m)
