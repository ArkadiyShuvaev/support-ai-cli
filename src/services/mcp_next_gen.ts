// import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// // 1. Setup Clients
// const datadogServer = new Client({
//   /* config */
// });
// const backofficeServer = new Client({
//   /* config */
// });
// const linearServer = new Client({
//   /* config */
// });

// // 2. Helper to fetch and namespace tools from a specific server
// async function fetchAndNamespace(server: Client, prefix: string) {
//   const rawTools = await server.listTools();
//   return rawTools.map((tool) => ({
//     ...tool,
//     name: `${prefix}__${tool.name}`, // e.g., 'linear__list_issues'
//   }));
// }

// // 3. The Master Filter Function
// export async function getAvailableTools(requiredToolNames: string[]) {
//   console.log(`\n🔍 Fetching required tools: ${requiredToolNames.join(', ')}`);

//   // A. Fetch and namespace EVERYTHING (in a real app, you'd cache this heavily)
//   const allTools = [
//     ...(await fetchAndNamespace(datadogServer, 'datadog')),
//     ...(await fetchAndNamespace(backofficeServer, 'backoffice')),
//     ...(await fetchAndNamespace(linearServer, 'linear')),
//   ];

//   // B. Filter down to ONLY the tools the KB article said we need
//   const filteredTools = allTools.filter((tool) =>
//     requiredToolNames.includes(tool.name),
//   );

//   return filteredTools;
// }

// // 4. The Router (Exactly as you wrote it!)
// export async function executeMcpTool(namespacedName: string, args: any) {
//   const [prefix, originalName] = namespacedName.split('__');
//   console.log(
//     `\n⚙️  [Router] Routing '${originalName}' to ${prefix} server...`,
//   );

//   switch (prefix) {
//     case 'linear':
//       return await linearServer.callTool({
//         name: originalName,
//         arguments: args,
//       });
//     case 'datadog':
//       return await datadogServer.callTool({
//         name: originalName,
//         arguments: args,
//       });
//     case 'backoffice':
//       return await backofficeServer.callTool({
//         name: originalName,
//         arguments: args,
//       });
//     default:
//       return { error: `Unknown MCP prefix: '${prefix}'` };
//   }
// }
