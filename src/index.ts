import {
  cleanLinearText,
  fetchLinearTickets,
  formatTicketTable,
} from './services/linear';
import {
  getKnowledgeBaseContext,
  getRelevantTools,
} from './services/opensearch';
import { planToolsNeeded, resolveTicket } from './services/bedrock';
import { maskPII } from './utils/pii';
import {
  printTicketDetail,
  printKnowledgeBaseResults,
  promptTicketSelection,
  promptConfirm,
  promptPostResolution,
} from './ui';
import { isDebugMode, debugPause } from './utils/debug';
import { getAvailableSystemsContext } from './services/mcp';

const HEADER = `
╔══════════════════════════════════════════════════════════╗
║         Support AI Tool  —  Local Prototype              ║
╚══════════════════════════════════════════════════════════╝`;

async function main() {
  console.log(HEADER);
  if (isDebugMode()) {
    console.log(
      '\n\x1b[33m[debug] DEBUG mode enabled — execution will pause after each pipeline phase.\x1b[0m',
    );
  }

  // Load ticket list once — re-shown after each resolution
  process.stdout.write('\n📋 Fetching open tickets from Linear...');
  const tickets = await fetchLinearTickets();
  console.log(` ${tickets.length} tickets found.\n`);

  while (true) {
    console.log(formatTicketTable(tickets));
    console.log();

    // Ticket selection
    const ticket = await promptTicketSelection(tickets);
    if (ticket === null) {
      console.log('\nGoodbye.\n');
      process.exit(0);
    }

    // Show detail with comments and attachments
    printTicketDetail(ticket);

    // Confirm before running pipeline
    const goWithAiPipeline = await promptConfirm(
      '▶  Start AI pipeline for this ticket? [Y/n]: ',
    );
    if (!goWithAiPipeline) {
      console.log('\nAborted. Returning to ticket list.\n');
      continue;
    }

    // Include comments in the context string passed to OpenSearch/Bedrock
    let rawTicketText = `${ticket.title}\n\n${ticket.description}`;
    rawTicketText = cleanLinearText(rawTicketText);

    // TODO: uncomment after testing. Temporary approach not to give LLM a hint on how to solve the issue.
    // if (ticket.comments.length > 0) {
    //   rawTicketText +=
    //     `\n\nComments:\n` +
    //     ticket.comments.map((c) => `${c.userName}: ${c.body}`).join('\n');
    // }

    // Mask PII before any text leaves local infrastructure
    const { maskedText: ticketText, vault } = maskPII(rawTicketText);

    // ── Phase 1a: KB RAG ───────────────────────────────────────────────────
    const {
      context: kbContext,
      hits,
      bm25Rank,
      knnRank,
    } = await getKnowledgeBaseContext(ticketText);
    printKnowledgeBaseResults(hits, bm25Rank, knnRank);
    await debugPause('Phase 1a complete: KB RAG context retrieved');

    // ── Phase 1b: Tool planning — ask the LLM what it needs ───────────────
    process.stdout.write('🧠 Planning investigation approach...');
    const systemsContext = await getAvailableSystemsContext();
    const plan = await planToolsNeeded(ticketText, kbContext, systemsContext);
    console.log(' Done.\n');
    if (plan) console.log(`📋 [Plan]: ${plan}\n`);
    await debugPause('Phase 1b complete: investigation plan produced');

    // ── Phase 1c: Tool RAG — select Top 5 tools from the catalog ──────────
    const selectedTools = await getRelevantTools(plan || '', 5);
    const toolNames = selectedTools
      .map((t) => ('toolSpec' in t ? t.toolSpec?.name : undefined))
      .filter(Boolean)
      .join(', ');
    console.log(`🔧 [Tools selected]: ${toolNames}\n`);
    await debugPause('Phase 1c complete: tools selected — starting agent loop');

    // ── Phase 2+: Investigation & execution loop ───────────────────────────
    await resolveTicket(ticketText, kbContext, selectedTools, vault);

    // Post-resolution menu
    const action = await promptPostResolution(ticket);
    if (action === 'quit') {
      console.log('\nGoodbye.\n');
      process.exit(0);
    }
    // action === "back" → loop continues, list is reprinted
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
