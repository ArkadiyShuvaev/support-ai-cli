import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config';
import { askConfirmation } from '../utils/prompt';
import { debugPause, debugLog } from '../utils/debug';
import { executeMcpTool, isReadOnlyTool } from './mcp';
import { type ObfuscationVault, unmaskPII } from '../utils/pii';

// ---------------------------------------------------------------------------
// showPayloadAndWaitForApproval — prints the Bedrock request payload in debug mode, then asks
// the operator to approve or abort before the request is sent.
// ---------------------------------------------------------------------------
async function showPayloadAndWaitForApproval(
  label: string,
  payload: unknown,
): Promise<boolean> {
  debugLog(`[Bedrock] ${label} payload:\n${JSON.stringify(payload, null, 2)}`);
  return debugPause(label, true);
}

// ---------------------------------------------------------------------------
// Client — initialized once at module load using credentials from config.
// The SDK resolves credentials automatically (env vars, SSO profile, instance
// metadata) using the standard AWS credential-provider chain.
// ---------------------------------------------------------------------------
const client = new BedrockRuntimeClient({ region: config.awsRegion });

// ---------------------------------------------------------------------------
// System prompt — sets the AI role and embeds the KB context so it is
// available to the model throughout the entire conversation without consuming
// user-message token budget.
// ---------------------------------------------------------------------------
function buildSystemPrompt(kbContext: string): SystemContentBlock[] {
  return [
    {
      text:
        `You are a support AI agent for a fintech platform.\n` +
        `Your role is to resolve operational support tickets by analyzing issues and using available tools.\n\n` +
        `## Data Privacy & PII Handling\n` +
        `- Customer PII (emails, phone numbers, UUIDs) in the ticket has been securely obfuscated (e.g., <EMAIL_1>, <PHONE_1>, or <UUID_1>).\n` +
        `- Do NOT attempt to guess or unmask the real data.\n` +
        `- When calling tools, you MUST pass these exact obfuscated tokens as parameters. The backend system will securely de-obfuscate them before executing the tool.\n\n` +
        `## Guidelines & Company Policies\n` +
        `- **Analyze first:** Analyze the ticket carefully before taking any action.\n` +
        `- **Prioritize unblocking:** Your primary goal is to unblock the customer as quickly as possible, potentially using a workaround, before worrying about long-term fixes.\n` +
        `- For read operations (queries, lookups), proceed with confidence.\n` +
        `- **Explain your plan:** For write operations (mutations, syncs, archives), explain what you are about to do and why before executing.\n` +
        `- **Ticket lifecycle:** If you need more info from the customer, update the status to 'Waiting User'. If waiting on an external provider (like Fourthline), use 'Waiting Third Party'.\n` +
        `- **Communication:** When you draft a suggested reply or leave an internal comment intended for the front-line operator, start your message with the ':ops:' emoji so our internal automation notifies them. Keep the obfuscated tokens in your suggested reply.\n` +
        `- Be concise and structured in your responses.\n\n` +
        `## Knowledge Base Context\n` +
        `The following articles from our internal knowledge base are relevant to this ticket:\n\n` +
        kbContext,
    },
  ];
}

// ---------------------------------------------------------------------------
// planToolsNeeded — Phase 1 planning call.
//
// A single, lightweight Bedrock turn that asks the model to describe its
// investigation approach given the ticket and KB context.
// ---------------------------------------------------------------------------
export async function planToolsNeeded(
  ticketText: string,
  kbContext: string,
  systemsContext: string,
): Promise<string> {
  // 1. Define the system prompt ONCE with all privacy rules
  const systemPrompt = [
    {
      text:
        'You are a concise support AI analyst. Answer in 2-3 sentences.\n\n' +
        '## Data Privacy\n' +
        'Customer PII in the ticket has been securely obfuscated (e.g., <EMAIL_1> or <UUID_1>). Treat these tokens as valid identifiers when formulating your plan.',
    },
  ];

  // 2. Wrap inputs in overarching XML tags and reference them in the prompt
  const planningMessages = [
    {
      role: 'user' as const,
      content: [
        {
          text:
            `<ticket>\n${ticketText}\n</ticket>\n\n` +
            `<knowledge_base>\n${kbContext}\n</knowledge_base>\n\n` +
            `<available_systems>\n${systemsContext}\n</available_systems>\n\n` +
            `Based on the <ticket> and <knowledge_base>, describe your technical investigation plan in plain English.\n` +
            `You only have access to the systems listed in <available_systems>. Restrict your planned actions to these platforms. Do not write code.`,
        },
      ],
    },
  ];

  // 3. Create a single source of truth for the payload
  const planningPayload = {
    system: systemPrompt,
    messages: planningMessages,
  };

  // The human now sees EXACTLY what will be sent to Bedrock
  const planningApproved = await showPayloadAndWaitForApproval(
    'Planning request',
    planningPayload,
  );

  if (!planningApproved) {
    console.log('🚫 [Human] Planning request aborted.');
    return '';
  }

  try {
    const response = await client.send(
      new ConverseCommand({
        modelId: config.awsModelId,
        ...planningPayload, // 4. Spread the exact approved payload here!
        inferenceConfig: { maxTokens: 256, temperature: 0.1 },
      }),
    );

    const content = response.output?.message?.content ?? [];
    const textBlock = content.find((b) => 'text' in b);
    return textBlock && 'text' in textBlock ? (textBlock.text ?? '') : '';
  } catch (err) {
    console.error('\n❌ [Bedrock] Planning call failed:', err);
    return '';
  }
}

// ---------------------------------------------------------------------------
// resolveTicket — the main Bedrock Converse API loop.
//
// Message history pattern (Bedrock requires strict alternation):
//   user(ticket) → assistant(text+toolUse?) → user(toolResults?) → assistant → …
// ---------------------------------------------------------------------------
export async function resolveTicket(
  ticketText: string,
  kbContext: string,
  availableTools: Tool[],
  vault: ObfuscationVault,
): Promise<void> {
  const system = buildSystemPrompt(kbContext);

  // Seed the conversation with the support ticket as the first user message.
  const messages: Message[] = [
    { role: 'user', content: [{ text: ticketText }] },
  ];

  console.log('\n🤖 [AI Agent] Starting analysis...\n');

  while (true) {
    // -----------------------------------------------------------------------
    // 1. Call Bedrock Converse API
    // -----------------------------------------------------------------------
    const agentPayload = { system, messages };
    const agentApproved = await showPayloadAndWaitForApproval(
      `Agent turn ${messages.length}`,
      agentPayload,
    );
    if (!agentApproved) {
      console.log('🚫 [Human] Agent request aborted.');
      break;
    }
    let response;
    try {
      response = await client.send(
        new ConverseCommand({
          modelId: config.awsModelId,
          system,
          messages,
          toolConfig: { tools: availableTools },
          inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
        }),
      );
    } catch (err) {
      console.error('\n❌ [Bedrock] API call failed:', err);
      break;
    }

    // -----------------------------------------------------------------------
    // 2. Extract and record the assistant's response message
    // -----------------------------------------------------------------------
    const outputMessage = response.output?.message;
    if (!outputMessage) {
      console.error(
        '\n❌ [Bedrock] Unexpected response: no message in output.',
      );
      break;
    }
    // Append assistant message to history BEFORE processing tool calls,
    // so the next user message (tool results) immediately follows it.
    messages.push(outputMessage);

    const contentBlocks: ContentBlock[] = outputMessage.content ?? [];

    // Print any text the assistant produced in this turn.
    for (const block of contentBlocks) {
      if ('text' in block && typeof block.text === 'string') {
        console.log(`\n🤖 [AI]: ${block.text}\n`);
      }
    }

    // Log token usage so the operator can monitor costs.
    if (response.usage) {
      const u = response.usage;
      console.log(
        `  [tokens: in=${u.inputTokens} out=${u.outputTokens} total=${u.totalTokens}]`,
      );
    }

    // -----------------------------------------------------------------------
    // 3. Branch on stop reason
    // -----------------------------------------------------------------------
    const stopReason = response.stopReason;

    if (stopReason === 'end_turn') {
      // Model is satisfied — we are done.
      break;
    }

    if (stopReason === 'max_tokens') {
      // Response was cut off; ask the model to continue from where it left off.
      console.warn(
        '\n⚠️  [Bedrock] Response truncated (max_tokens). Continuing...',
      );
      messages.push({ role: 'user', content: [{ text: 'Please continue.' }] });
      continue;
    }

    if (stopReason === 'tool_use') {
      // -------------------------------------------------------------------
      // 4. Collect all tool_use blocks from the assistant's response
      // -------------------------------------------------------------------
      const toolUseBlocks = contentBlocks.filter(
        (b): b is ContentBlock.ToolUseMember =>
          'toolUse' in b && b.toolUse !== undefined,
      );

      if (toolUseBlocks.length === 0) {
        console.error(
          '\n❌ [Bedrock] stop_reason=tool_use but no toolUse blocks found.',
        );
        break;
      }

      // Accumulate all results into one user message so the message history
      // stays strictly alternating (one user message per assistant turn).
      const toolResultBlocks: ContentBlock[] = [];

      for (const block of toolUseBlocks) {
        const { toolUseId, name, input } = block.toolUse;

        console.log(`\n🔧 [Tool Request] ${name}  (id: ${toolUseId})`);
        console.log(`   Input: ${JSON.stringify(input, null, 2)}`);

        // -----------------------------------------------------------------
        // 5. HITL gate — read-only tools are auto-approved
        // -----------------------------------------------------------------
        let approved = true;
        if (isReadOnlyTool(name ?? '')) {
          console.log('   (auto-approved: read-only tool)');
        } else {
          approved = await askConfirmation(
            `Execute tool '${name}' with the above input?`,
          );
        }

        if (!approved) {
          console.log('🚫 [Human] Tool execution denied.\n');
          toolResultBlocks.push({
            toolResult: {
              toolUseId: toolUseId!,
              content: [{ text: 'Tool execution denied by operator.' }],
              status: 'error',
            },
          });
          continue;
        }

        // -----------------------------------------------------------------
        // 6. Execute the tool via MCP and capture the result
        // De-obfuscate tool inputs here — PII never crossed the Bedrock boundary.
        // -----------------------------------------------------------------
        try {
          const realInput = JSON.parse(unmaskPII(JSON.stringify(input), vault));
          const result = await executeMcpTool(name!, realInput);
          toolResultBlocks.push({
            toolResult: {
              toolUseId: toolUseId!,
              content: [{ json: result }],
              status: 'success',
            },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n❌ [MCP] Tool '${name}' failed: ${msg}`);
          toolResultBlocks.push({
            toolResult: {
              toolUseId: toolUseId!,
              content: [{ text: `Tool execution failed: ${msg}` }],
              status: 'error',
            },
          });
        }
      }

      // Send all tool results back to the model as a single user message.
      messages.push({ role: 'user', content: toolResultBlocks });
      await debugPause(
        `Phase 2 iteration complete: ${toolUseBlocks.length} tool(s) executed — continuing agent loop`,
      );
      continue;
    }

    // Catch-all for unexpected stop reasons (content_filtered, etc.)
    console.warn(
      `\n⚠️  [Bedrock] Unexpected stop reason: '${stopReason}'. Stopping.`,
    );
    break;
  }

  console.log('\n✅ [AI Agent] Ticket resolution complete.\n');
}
