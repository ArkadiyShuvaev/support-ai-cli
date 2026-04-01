import * as readline from 'readline/promises';
import * as rl from 'readline';
import { stdin as input, stdout as output } from 'process';
import {
  fetchTicketWithComments,
  formatPriority,
  LinearTicket,
} from './services/linear';
import { type ArticleSource, type RankedHit } from './services/opensearch';

const NOTION_WORKSPACE_SLUG = process.env.NOTION_WORKSPACE_SLUG;

export function printKnowledgeBaseResults(
  hits: RankedHit<ArticleSource>[],
  bm25Rank: Map<string, number>,
  knnRank: Map<string, number>,
): void {
  const rankStr = (map: Map<string, number>, id: string): string => {
    const r = map.get(id);
    return r !== undefined ? `#${r + 1}` : '  —';
  };

  console.log(
    `  ${'BM25'.padEnd(5)}  ${'kNN'.padEnd(5)}  ${'RRF score'.padEnd(10)}  title`,
  );
  console.log(`  ${'─'.repeat(60)}`);
  hits.forEach((hit) => {
    const bm25 = rankStr(bm25Rank, hit.id).padEnd(5);
    const knn = rankStr(knnRank, hit.id).padEnd(5);
    const score = hit.score.toFixed(4).padEnd(10);
    const notionUrl =
      hit.source.page_ref && NOTION_WORKSPACE_SLUG
        ? `https://www.notion.so/${NOTION_WORKSPACE_SLUG}/${hit.source.page_ref.replace(/-/g, '')}`
        : null;
    const titleLink = notionUrl
      ? `\x1b]8;;${notionUrl}\x1b\\${hit.source.title}\x1b]8;;\x1b\\`
      : hit.source.title;
    console.log(`  ${bm25}  ${knn}  ${score}  ${titleLink}`);
  });
  console.log();
}

function extractImageLinks(text: string): string[] {
  const links: string[] = [];
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    links.push(match[1]);
  }

  return links;
}

export function printTicketDetail(ticket: LinearTicket) {
  const { comments } = ticket;
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  const idLink = ticket.url
    ? `\x1b]8;;${ticket.url}\x1b\\${ticket.identifier}\x1b]8;;\x1b\\`
    : ticket.identifier;
  console.log(`  ${idLink}  ·  ${ticket.title}`);
  console.log(line);
  console.log(`  Priority : ${formatPriority(ticket.priority)}`);
  console.log(`  Status   : ${ticket.status}`);
  console.log(`  Labels   : ${ticket.labels.join('  |  ')}`);
  console.log(
    `  Created  : ${new Date(ticket.createdAt).toLocaleString('en-GB')}`,
  );
  console.log(`\n  Description:\n`);
  ticket.description.split('\n').forEach((l: string) => console.log(`    ${l}`));

  console.log(`\n${line}`);

  if (comments.length === 0) {
    console.log(`  Comments : None`);
  } else {
    console.log(`  Comments (${comments.length}):\n`);
    comments.forEach((c) => {
      const dateStr = new Date(c.createdAt).toLocaleString('en-GB');
      console.log(`  [${dateStr}] ${c.userName}:`);
      c.body.split('\n').forEach((l: string) => console.log(`    ${l}`));
      console.log();
    });
  }

  const allText = [ticket.description, ...comments.map((c) => c.body)].join(
    '\n',
  );
  const attachments = extractImageLinks(allText);

  if (attachments.length > 0) {
    console.log(`${line}`);
    console.log(`  📎 Attachments (${attachments.length}):\n`);
    attachments.forEach((url) => console.log(`    • ${url}`));
  }

  console.log(`${line}\n`);
}

/** Reads a line from stdin character-by-character. Returns the string on Enter, null on Escape. */
export function promptRaw(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    rl.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    process.stdout.write(question);

    let buf = '';

    function onKey(
      _: unknown,
      key: { name: string; sequence: string; ctrl: boolean },
    ) {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        process.exit(0);
      } else if (key.name === 'escape') {
        cleanup();
        process.stdout.write('\n');
        resolve(null);
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        process.stdout.write('\n');
        resolve(buf);
      } else if (key.name === 'backspace') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (!key.ctrl && key.sequence) {
        buf += key.sequence;
        process.stdout.write(key.sequence);
      }
    }

    function cleanup() {
      input.removeListener('keypress', onKey);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    }

    input.on('keypress', onKey);
  });
}

export async function promptTicketSelection(
  tickets: LinearTicket[],
): Promise<LinearTicket | null> {
  while (true) {
    const answer = await promptRaw(
      `Select [1-${tickets.length}], enter a Ticket ID (e.g., OPS-123), or Esc: `,
    );

    if (answer === null) return null;
    const userInput = answer.trim();
    if (!userInput) continue;

    // 1. Check if it's a list index (e.g., "1")
    const idx = parseInt(userInput, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < tickets.length) {
      const selected = tickets[idx];
      process.stdout.write(
        `  🔍 Fetching ${selected.identifier} from Linear...`,
      );
      const ticket = await fetchTicketWithComments(selected.identifier);
      if (ticket) {
        console.log(' Done.');
        return ticket;
      }
      console.log(' ❌ Failed to fetch full ticket, using cached version.');
      return selected;
    }

    // 2. Check if it looks like a Ticket ID (e.g., "OPS-36705")
    if (userInput.includes('-')) {
      process.stdout.write(
        `  🔍 Fetching ${userInput.toUpperCase()} from Linear...`,
      );
      const ticket = await fetchTicketWithComments(userInput);
      if (ticket) {
        console.log(' Found.');
        return ticket;
      }
      console.log(' ❌ Ticket not found.');
    } else {
      console.log(
        `  ⚠  Invalid selection. Please enter 1-${tickets.length} or a Ticket ID.`,
      );
    }
  }
}

export async function promptConfirm(question: string): Promise<boolean> {
  const iface = readline.createInterface({ input, output });
  const answer = await iface.question(question);
  iface.close();
  const n = answer.trim().toLowerCase();
  return n !== 'n' && n !== 'no';
}

export type PostAction = 'back' | 'quit';

export async function promptPostResolution(
  _ticket: LinearTicket,
): Promise<PostAction> {
  const iface = readline.createInterface({ input, output });
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  console.log('  What would you like to do next?');
  console.log('  [1] Back to ticket list');
  console.log('  [2] Quit');
  // Placeholder — ticket management actions (close, in_progress, etc.) will go here
  console.log(`${line}\n`);

  let action: PostAction | undefined;
  while (!action) {
    const answer = await iface.question('Choose [1-2]: ');
    switch (answer.trim()) {
      case '1':
        action = 'back';
        break;
      case '2':
        action = 'quit';
        break;
      default:
        console.log('  ⚠  Enter 1 or 2.\n');
    }
  }

  iface.close();
  return action;
}
