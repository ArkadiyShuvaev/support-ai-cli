export interface LinearTicket {
  identifier: string;
  url: string;
  title: string;
  description: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  status: string;
  labels: string[];
  createdAt: string;
  comments: LinearComment[];
}

export interface LinearComment {
  id: string;
  body: string;
  userName: string;
  createdAt: string;
}

const PRIORITY_LABEL: Record<LinearTicket['priority'], string> = {
  urgent: '🔴 URGENT',
  high: '🟠 HIGH  ',
  medium: '🟡 MEDIUM',
  low: '🔵 LOW   ',
};

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getServerTransportParams } from './mcp_config';
import { config } from '../config';

// Define our DevOps/Developer status hierarchy globally so we can filter with it
function getStatusRank(statusName: string): number {
  const s = statusName.toLowerCase();

  // 1. Action Needed Right Now
  if (
    s.includes('investigate') ||
    s.includes('triage') ||
    s.includes('blocked') ||
    s.includes('needs fix')
  )
    return 1;
  // 2. Currently Working On
  if (
    s.includes('in progress') ||
    s.includes('testing') ||
    s.includes('in review')
  )
    return 2;
  // 3. Waiting on someone else
  if (s.includes('waiting')) return 3;
  // 4. Queue / Backlog
  if (s.includes('todo') || s.includes('backlog') || s.includes('refined'))
    return 4;
  // 99. Dead / Done / Ignore
  if (
    s.includes('solved') ||
    s.includes('done') ||
    s.includes('canceled') ||
    s.includes('duplicate') ||
    s.includes('close') ||
    s.includes('auto-close')
  )
    return 99;

  // Default fallback for unrecognized statuses
  return 10;
}

function mapLinearPriority(p: number): LinearTicket['priority'] {
  if (p === 1) return 'urgent';
  if (p === 2) return 'high';
  if (p === 3) return 'medium';
  return 'low';
}

function mapLinearIssue(issue: Record<string, any>): LinearTicket {
  return {
    identifier: issue.id ?? 'UNKNOWN',
    url: issue.url ?? '',
    title: issue.title ?? '',
    description: issue.description ?? '',
    priority: mapLinearPriority(issue.priority?.value ?? 3),
    status: issue.state?.name ?? issue.status ?? 'Todo',
    labels: Array.isArray(issue.labels) ? issue.labels : [],
    createdAt: issue.createdAt ?? new Date().toISOString(),
    comments: [],
  };
}

async function fetchLinearTicketsLive(): Promise<LinearTicket[]> {
  const transport = new StdioClientTransport(
    getServerTransportParams('linear'),
  );

  const client = new Client(
    { name: 'support-cli', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  try {
    const activeStateTypes = ['triage', 'backlog', 'unstarted', 'started'];

    // 💡 Create a helper function to handle the pagination for a SINGLE state type
    const fetchStateBucket = async (stateType: string) => {
      let bucketIssues: Record<string, any>[] = [];
      let currentCursor: string | undefined = undefined;

      while (true) {
        const args: Record<string, any> = {
          team: config.linearTeam,
          state: stateType,
          limit: 250,
          includeArchived: false,
        };

        if (currentCursor) {
          args.cursor = currentCursor;
        }

        const response = await client.callTool({
          name: 'list_issues',
          arguments: args,
        });

        const content = response.content as Array<{
          type: string;
          text?: string;
        }>;
        const raw = content.find((c) => c.type === 'text')?.text ?? '{}';

        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          console.error(
            `[Linear MCP] Failed to parse API response for ${stateType}.`,
          );
          break;
        }

        const issues = Array.isArray(parsed) ? parsed : parsed.issues || [];
        bucketIssues = bucketIssues.concat(issues);

        const nextCursor =
          parsed.cursor || parsed.nextCursor || parsed.pageInfo?.endCursor;

        // Break pagination loop if we got less than requested or no cursor
        if (issues.length < 250 || !nextCursor) {
          break;
        }

        currentCursor = nextCursor;
      }
      return bucketIssues;
    };

    // 💡 Execute all 4 state bucket fetchers at the exact same time
    const results = await Promise.all(activeStateTypes.map(fetchStateBucket));

    // 💡 Flatten the array of arrays into a single list of issues
    const allActiveIssues = results.flat();

    return allActiveIssues.map(mapLinearIssue);
  } finally {
    await client.close();
  }
}
export async function fetchLinearTickets(): Promise<LinearTicket[]> {
  const priorityOrder: Record<LinearTicket['priority'], number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  let tickets = await fetchLinearTicketsLive();

  tickets = tickets.filter((t) => {
    // 1. Drop any closed/dead tickets
    const isActive = getStatusRank(t.status) !== 99;

    // 2. Ensure it belongs to the Account Opening domain
    // (This catches "Reviews", "Onboarding", etc.)
    const isRequiredView = t.labels.some((label) =>
      label.toLowerCase().includes('account opening'),
    );

    return isActive && isRequiredView;
  });

  // Sort primarily by Status Rank, and secondarily by Priority
  return tickets.sort((a, b) => {
    const rankA = getStatusRank(a.status);
    const rankB = getStatusRank(b.status);

    if (rankA !== rankB) {
      return rankA - rankB; // Status wins
    }
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

export function formatPriority(priority: LinearTicket['priority']): string {
  return PRIORITY_LABEL[priority];
}

export function formatTicketTable(tickets: LinearTicket[]): string {
  const W = { num: 3, id: 10, pri: 9, stat: 16, title: 38 };

  const divider = (l: string, m: string, r: string) =>
    l +
    '─'.repeat(W.num + 2) +
    m +
    '─'.repeat(W.id + 2) +
    m +
    '─'.repeat(W.pri + 2) +
    m +
    '─'.repeat(W.stat + 2) +
    m +
    '─'.repeat(W.title + 2) +
    r;

  const row = (
    num: string,
    id: string,
    pri: string,
    stat: string,
    title: string,
  ) =>
    `│ ${num.padEnd(W.num)} │ ${id.padEnd(W.id)} │ ${pri.padEnd(W.pri)} │ ${stat.padEnd(W.stat)} │ ${title.padEnd(W.title)} │`;

  const lines: string[] = [
    divider('┌', '┬', '┐'),
    row('#', 'TICKET ID', 'PRIORITY', 'STATUS', 'TITLE'),
    divider('├', '┼', '┤'),
  ];

  tickets.forEach((t, i) => {
    const title =
      t.title.length > W.title ? t.title.slice(0, W.title - 1) + '…' : t.title;
    const status =
      t.status.length > W.stat ? t.status.slice(0, W.stat - 1) + '…' : t.status;

    lines.push(
      row(
        String(i + 1),
        t.identifier,
        PRIORITY_LABEL[t.priority],
        status,
        title,
      ),
    );
  });

  lines.push(divider('└', '┴', '┘'));
  return lines.join('\n');
}

export async function fetchTicketComments(
  issueId: string,
): Promise<LinearComment[]> {
  const transport = new StdioClientTransport(
    getServerTransportParams('linear'),
  );

  const client = new Client(
    { name: 'support-cli', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  try {
    const response = await client.callTool({
      name: 'list_comments',
      arguments: { issueId },
    });

    const content = response.content as Array<{ type: string; text?: string }>;
    const raw = content.find((c) => c.type === 'text')?.text ?? '[]';

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[Linear MCP] Failed to parse comments response.');
      return [];
    }

    const comments = Array.isArray(parsed) ? parsed : parsed.comments || [];

    return comments
      .map(
        (c: any): LinearComment => ({
          id: c.id ?? 'UNKNOWN',
          body: c.body ?? '',
          userName: c.user?.name ?? 'Unknown User',
          createdAt: c.createdAt ?? new Date().toISOString(),
        }),
      )
      .sort(
        (a: LinearComment, b: LinearComment) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
  } finally {
    await client.close();
  }
}

export async function fetchTicketWithComments(
  id: string,
): Promise<LinearTicket | null> {
  const [ticket, comments] = await Promise.all([
    fetchTicketById(id),
    fetchTicketComments(id),
  ]);
  if (!ticket) return null;
  return { ...ticket, comments };
}

export async function fetchTicketById(
  id: string,
): Promise<LinearTicket | null> {
  const transport = new StdioClientTransport(
    getServerTransportParams('linear'),
  );

  const client = new Client(
    { name: 'support-cli', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  try {
    const response = await client.callTool({
      name: 'get_issue',
      arguments: { id: id.toUpperCase() }, // Linear IDs are case-insensitive but usually upper
    });

    const content = response.content as Array<{ type: string; text?: string }>;
    const raw = content.find((c) => c.type === 'text')?.text ?? '{}';

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.error) return null;

    return mapLinearIssue(parsed);
  } catch (err) {
    return null;
  } finally {
    await client.close();
  }
}

export function cleanLinearText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(
      'Start your message with `:ops:` emoji to answer the operator',
      '',
    );
}
