import { Client } from '@opensearch-project/opensearch';
import { type Tool } from '@aws-sdk/client-bedrock-runtime';
import { debugLog } from '../utils/debug';

const OPENSEARCH_URL = process.env.OPENSEARCH_URL ?? 'http://localhost:9200';
const INDEX_NAME = process.env.INDEX_NAME ?? 'support-cli-kb';
const TOOLS_INDEX_NAME = process.env.SCHEMA_INDEX_NAME ?? 'support-cli-tools';
const EMBEDDING_SERVER_URL =
  process.env.EMBEDDING_SERVER_URL ?? 'http://localhost:8001';

const client = new Client({ node: OPENSEARCH_URL });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArticleSource {
  title: string;
  content: string;
  page_ref: string;
}

interface Hit<S> {
  id: string;
  rank: number; // position in its source list (0-based)
  source: S;
}

export interface RankedHit<S> {
  id: string;
  score: number;
  source: S;
}

export interface KnowledgeBaseResult {
  context: string;
  hits: RankedHit<ArticleSource>[];
  bm25Rank: Map<string, number>;
  knnRank: Map<string, number>;
}

interface ToolSource {
  id: string;
  server: string;
  name: string;
  description: string;
  input_schema_json: string;
}

// ---------------------------------------------------------------------------
// Embedding — calls the Python embedding server (same model as the indexer).
// ---------------------------------------------------------------------------

async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch(`${EMBEDDING_SERVER_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Embedding server error: ${res.status} ${res.statusText}`);
  }
  const { embedding } = (await res.json()) as { embedding: number[] };
  return embedding;
}

// ---------------------------------------------------------------------------
// BM25 — multi_match across all text fields and their language sub-fields.
// ---------------------------------------------------------------------------

async function bm25Search(
  query: string,
  topN: number,
): Promise<Hit<ArticleSource>[]> {
  const response = await client.search({
    index: INDEX_NAME,
    body: {
      size: topN,
      _source: { excludes: ['embedding'] },
      query: {
        multi_match: {
          query,
          fields: [
            'title^3',
            'title.fr^3',
            'title.en^3',
            'content',
            'content.fr',
            'content.en',
          ],
        },
      },
    },
  });

  return (response.body.hits.hits as any[]).map((h, rank) => ({
    id: h._id as string,
    rank,
    source: h._source as ArticleSource,
  }));
}

// ---------------------------------------------------------------------------
// kNN — approximate nearest-neighbour search over the embedding field.
// ---------------------------------------------------------------------------

async function knnSearch(
  embedding: number[],
  topN: number,
): Promise<Hit<ArticleSource>[]> {
  const response = await client.search({
    index: INDEX_NAME,
    body: {
      size: topN,
      _source: { excludes: ['embedding'] },
      query: {
        knn: {
          embedding: { vector: embedding, k: topN },
        },
      },
    },
  });

  return (response.body.hits.hits as any[]).map((h, rank) => ({
    id: h._id as string,
    rank,
    source: h._source as ArticleSource,
  }));
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion — merges two ranked lists into one.
// score = Σ  1 / (k + rank + 1)  for each list the document appears in.
// k=60 is the standard default (Cormack & Clarke 2009).
// ---------------------------------------------------------------------------

function rrf<S>(lists: Hit<S>[][], k = 60): RankedHit<S>[] {
  const scores = new Map<string, { score: number; source: S }>();

  for (const list of lists) {
    for (const hit of list) {
      const entry = scores.get(hit.id) ?? { score: 0, source: hit.source };
      entry.score += 1 / (k + hit.rank + 1);
      scores.set(hit.id, entry);
    }
  }

  return [...scores.entries()]
    .map(([id, { score, source }]) => ({ id, score, source }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Tools hybrid search — BM25 + kNN over the support-cli-tools index.
// ---------------------------------------------------------------------------

async function toolsBm25Search(
  query: string,
  topN: number,
): Promise<Hit<ToolSource>[]> {
  const response = await client.search({
    index: TOOLS_INDEX_NAME,
    body: {
      size: topN,
      _source: { excludes: ['embedding'] },
      query: {
        multi_match: {
          query,
          fields: ['name^3', 'description', 'input_schema_json'],
        },
      },
    },
  });

  return (response.body.hits.hits as any[]).map((h, rank) => ({
    id: h._id as string,
    rank,
    source: h._source as ToolSource,
  }));
}

async function toolsKnnSearch(
  embedding: number[],
  topN: number,
): Promise<Hit<ToolSource>[]> {
  const response = await client.search({
    index: TOOLS_INDEX_NAME,
    body: {
      size: topN,
      _source: { excludes: ['embedding'] },
      query: {
        knn: {
          embedding: { vector: embedding, k: topN },
        },
      },
    },
  });

  return (response.body.hits.hits as any[]).map((h, rank) => ({
    id: h._id as string,
    rank,
    source: h._source as ToolSource,
  }));
}

// ---------------------------------------------------------------------------
// Format an article as XML — matches the prompt format the LLM expects.
// ---------------------------------------------------------------------------

function formatArticle(source: ArticleSource, index: number): string {
  return `<article index="${index}">
  <title>${source.title}</title>
  <content>${source.content}</content>
</article>`;
}

// ---------------------------------------------------------------------------
// getKnowledgeBaseContext — public API used by the orchestrator.
// Runs BM25 + kNN in parallel, fuses with RRF, returns top articles as XML
// plus the raw hits and rank maps for display by the caller.
// ---------------------------------------------------------------------------

export async function getKnowledgeBaseContext(
  ticketDescription: string,
): Promise<KnowledgeBaseResult> {
  console.log(
    `\n🔍 [OpenSearch] Running hybrid search (BM25 + kNN with RRF)...`,
  );

  const [embedding, bm25Results] = await Promise.all([
    embedQuery(ticketDescription),
    bm25Search(ticketDescription, 10),
  ]);

  const knnResults = await knnSearch(embedding, 10);

  const bm25Rank = new Map(bm25Results.map((h) => [h.id, h.rank]));
  const knnRank = new Map(knnResults.map((h) => [h.id, h.rank]));

  const ranked = rrf([bm25Results, knnResults]);
  const hits = ranked.slice(0, 3);

  console.log(`✅ [OpenSearch] Returning ${hits.length} article(s) via RRF.\n`);

  return {
    context: hits
      .map((hit, i) => formatArticle(hit.source, i + 1))
      .join('\n\n'),
    hits,
    bm25Rank,
    knnRank,
  };
}

// ---------------------------------------------------------------------------
// getRelevantTools — Phase 1c tool discovery via hybrid search on support-cli-tools.
// Embeds the LLM's investigation plan, runs BM25 + kNN in parallel, fuses
// with RRF, and returns the top N tools in the Bedrock Tool shape.
// The tool name uses the {server}__{tool_name} id so MCP routing works.
// ---------------------------------------------------------------------------

export async function getRelevantTools(
  plan: string,
  topN = 5,
): Promise<Tool[]> {
  const [embedding, bm25Results] = await Promise.all([
    embedQuery(plan),
    toolsBm25Search(plan, topN * 2),
  ]);

  const knnResults = await toolsKnnSearch(embedding, topN * 2);
  const ranked = rrf([bm25Results, knnResults]);
  const top = ranked.slice(0, topN);

  debugLog(
    `[OpenSearch] Top ${top.length} tools from support-cli-tools:\n` +
      top.map((h) => `  ${h.score.toFixed(4)}  ${h.source.id}`).join('\n'),
  );

  return top.map(({ source }) => ({
    toolSpec: {
      name: source.id,
      description: source.description,
      inputSchema: {
        json: JSON.parse(source.input_schema_json) as Record<string, unknown>,
      },
    },
  })) as unknown as Tool[];
}
