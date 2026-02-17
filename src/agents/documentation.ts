import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { join } from "node:path";
import { z } from "zod";
import { createModel } from "../utils/model";
import {
  listComments,
  notion,
  queryDatabase,
  readPageContent,
  retrieveDatabase,
  retrievePage,
  retrievePageProperty,
} from "../tools/notion";

/** Notion page/database IDs for the public documentation collections. */
const DOCUMENTATION_COLLECTION_IDS = new Set([
  "282181f3b6ed80ef94cdcae7e3ccf865",
  "282181f3b6ed801ab5b7c1bd370febac",
  "282181f3b6ed80a287baf7a1945b72a7",
  "282181f3b6ed80c5b09fec1f8b2997ef",
  "282181f3b6ed80c8b694daa51b155b7d",
  "282181f3b6ed800c8878ee011d80784a",
]);

/** Normalize a Notion ID by stripping hyphens for consistent comparison. */
function normalizeId(id: string): string {
  return id.replace(/-/g, "");
}

const MAX_ANCESTRY_DEPTH = 10;

/** Cache of id → boolean for ancestry checks (persists for process lifetime). */
const ancestryCache = new Map<string, boolean>();

/** Walk up the parent chain to check if a Notion object lives under an allowed collection. */
async function isUnderDocumentationCollection(obj: any): Promise<boolean> {
  let current = obj;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    const parent = current.parent;
    if (!parent) return false;

    const parentId = parent.database_id ?? parent.page_id ?? null;
    if (!parentId) return false; // reached workspace root

    const normalized = normalizeId(parentId);

    // Direct match — this ancestor is a documentation collection
    if (DOCUMENTATION_COLLECTION_IDS.has(normalized)) return true;

    // Check cache
    const cached = ancestryCache.get(normalized);
    if (cached !== undefined) return cached;

    // Fetch the parent and continue walking up
    try {
      current =
        parent.database_id
          ? await notion.databases.retrieve({ database_id: parentId })
          : await notion.pages.retrieve({ page_id: parentId });
    } catch {
      return false; // parent inaccessible
    }
  }
  return false;
}

/** Check ancestry for a result, using and populating the cache. */
async function isInDocumentationCollection(result: any): Promise<boolean> {
  const id = normalizeId(result.id);
  const cached = ancestryCache.get(id);
  if (cached !== undefined) return cached;

  const allowed = await isUnderDocumentationCollection(result);
  ancestryCache.set(id, allowed);
  return allowed;
}

type RichTextItem = { plain_text: string };
function richTextToPlain(rt: RichTextItem[]): string {
  return rt.map((item) => item.plain_text).join("");
}

/** Search scoped to documentation collections only. */
const searchDocumentation = tool({
  description: "Search Purdue Hackers documentation pages by keyword. Only returns results from the documentation collections.",
  inputSchema: z.object({
    query: z.string().describe("Search keyword"),
    page_size: z.number().optional().default(20).describe("Max results to fetch before filtering (max 100)"),
  }),
  execute: async ({ query, page_size }) => {
    const response = await notion.search({
      query,
      page_size: Math.min(page_size, 100),
    });
    const checks = await Promise.all(
      response.results.map(async (r) => ({ result: r, allowed: await isInDocumentationCollection(r) })),
    );
    const filtered = checks.filter((c) => c.allowed).map((c) => c.result);
    return JSON.stringify(
      filtered.map((r: any) => ({
        id: r.id,
        object: r.object,
        url: r.url,
        ...(r.object === "page" && {
          title: r.properties?.title
            ? richTextToPlain(r.properties.title.title ?? [])
            : r.properties?.Name
              ? richTextToPlain(r.properties.Name.title ?? [])
              : undefined,
        }),
        ...(r.object === "database" && {
          title: richTextToPlain(r.title ?? []),
        }),
      })),
    );
  },
});

const systemPromptPath = join(import.meta.dir, "../prompts/documentation/SYSTEM.md");

/** Cached system prompt, loaded once on first access. */
let systemPromptCache: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (!systemPromptCache) {
    systemPromptCache = await Bun.file(systemPromptPath).text();
  }
  return systemPromptCache;
}

/** Create a read-only documentation subagent for querying Purdue Hackers info from Notion. */
export function createDocumentationTool(userId: string) {
  return tool({
    description:
      "Search and read Purdue Hackers documentation and workspace content from Notion. Use for any question about Purdue Hackers, events, projects, or documentation.",
    inputSchema: z.object({
      task: z.string().describe("The question or information request about Purdue Hackers"),
    }),
    execute: async ({ task }, { abortSignal }) => {
      const instructions = await loadSystemPrompt();

      const tools = {
        search_documentation: searchDocumentation,
        retrieve_page: retrievePage,
        retrieve_database: retrieveDatabase,
        read_page_content: readPageContent,
        query_database: queryDatabase,
        retrieve_page_property: retrievePageProperty,
        list_comments: listComments,
      };

      const subagent = new ToolLoopAgent({
        model: createModel(userId),
        instructions,
        tools,
        stopWhen: stepCountIs(10),
      });
      const result = await subagent.generate({ prompt: task, abortSignal });
      return result.text;
    },
  });
}
