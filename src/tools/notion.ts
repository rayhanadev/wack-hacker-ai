import { Client } from "@notionhq/client";
import { tool } from "ai";
import { join } from "node:path";
import { z } from "zod";
import { env } from "../env";
import { blockTreeToMarkdown, markdownToBlocks } from "../utils/notion-codec";
import { createSkillSystem } from "./skills";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export const notion = new Client({ auth: env.NOTION_TOKEN });

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const {
  getBaseToolNames,
  getSkillToolNames,
  createLoadSkillTool,
  resolveSystemPrompt,
} = createSkillSystem({
  skillsDir: join(import.meta.dir, "../prompts/notion/skills"),
  skillNames: ["pages", "databases", "comments"],
  baseToolNames: [
    "load_skill",
    "search_notion",
    "retrieve_page",
    "retrieve_database",
    "list_users",
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RichTextItem = { plain_text: string };

/** Extract plain text from a Notion rich_text array. */
function richTextToPlain(rt: RichTextItem[]): string {
  return rt.map((item) => item.plain_text).join("");
}

/** Convert a plain string to Notion rich_text format. */
function plainToRichText(str: string) {
  return [{ text: { content: str } }];
}

const json = JSON.stringify;

/** Recursively fetch all blocks under a page/block and build a tree. */
async function fetchBlockTree(blockId: string): Promise<{ block: any; children: any[] }[]> {
  const tree: { block: any; children: any[] }[] = [];
  let cursor: string | undefined;
  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const block of response.results) {
      const b = block as any;
      const children = b.has_children ? await fetchBlockTree(b.id) : [];
      tree.push({ block: b, children });
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return tree;
}

/** Delete all top-level blocks on a page. */
async function deleteAllBlocks(pageId: string) {
  let cursor: string | undefined;
  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    await Promise.all(
      response.results.map((b) => notion.blocks.delete({ block_id: b.id })),
    );
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
}

// ---------------------------------------------------------------------------
// Base read tools (always available)
// ---------------------------------------------------------------------------

export const searchNotion = tool({
  description: "Search Notion pages and databases by keyword.",
  inputSchema: z.object({
    query: z.string().describe("Search keyword"),
    filter: z
      .enum(["page", "data_source"])
      .optional()
      .describe("Restrict results to pages or databases (use 'data_source' for databases)"),
    page_size: z.number().optional().default(10).describe("Max results (max 100)"),
  }),
  execute: async ({ query, filter, page_size }) => {
    const response = await notion.search({
      query,
      ...(filter && { filter: { value: filter, property: "object" } }),
      page_size: Math.min(page_size, 100),
    });
    return json(
      response.results.map((r: any) => ({
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

export const retrievePage = tool({
  description: "Fetch a Notion page's properties and metadata by ID.",
  inputSchema: z.object({
    page_id: z.string().describe("Page ID or URL"),
  }),
  execute: async ({ page_id }) => {
    const page: any = await notion.pages.retrieve({ page_id });
    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries(page.properties as Record<string, any>)) {
      properties[key] = { type: value.type, id: value.id };
      if (value.type === "title") properties[key].value = richTextToPlain(value.title ?? []);
      else if (value.type === "rich_text") properties[key].value = richTextToPlain(value.rich_text ?? []);
      else if (value.type === "number") properties[key].value = value.number;
      else if (value.type === "select") properties[key].value = value.select?.name;
      else if (value.type === "multi_select") properties[key].value = value.multi_select?.map((s: any) => s.name);
      else if (value.type === "status") properties[key].value = value.status?.name;
      else if (value.type === "date") properties[key].value = value.date;
      else if (value.type === "checkbox") properties[key].value = value.checkbox;
      else if (value.type === "url") properties[key].value = value.url;
      else if (value.type === "email") properties[key].value = value.email;
      else if (value.type === "phone_number") properties[key].value = value.phone_number;
      else if (value.type === "people") properties[key].value = value.people?.map((p: any) => p.name ?? p.id);
      else if (value.type === "relation") properties[key].value = value.relation?.map((r: any) => r.id);
      else if (value.type === "formula") properties[key].value = value.formula;
      else if (value.type === "rollup") properties[key].value = value.rollup;
    }
    return json({
      id: page.id,
      url: page.url,
      created_time: page.created_time,
      last_edited_time: page.last_edited_time,
      archived: page.archived,
      properties,
    });
  },
});

export const retrieveDatabase = tool({
  description: "Fetch a Notion database schema and metadata by ID.",
  inputSchema: z.object({
    database_id: z.string().describe("Database ID or URL"),
  }),
  execute: async ({ database_id }) => {
    const db: any = await notion.databases.retrieve({ database_id });
    const schema: Record<string, any> = {};
    for (const [key, value] of Object.entries(db.properties as Record<string, any>)) {
      schema[key] = { type: value.type, id: value.id };
      if (value.type === "select") schema[key].options = value.select?.options?.map((o: any) => o.name);
      else if (value.type === "multi_select") schema[key].options = value.multi_select?.options?.map((o: any) => o.name);
      else if (value.type === "status") schema[key].groups = value.status?.groups?.map((g: any) => ({ name: g.name, options: g.options?.map((o: any) => o.name) }));
    }
    return json({
      id: db.id,
      title: richTextToPlain(db.title ?? []),
      description: richTextToPlain(db.description ?? []),
      url: db.url,
      properties: schema,
    });
  },
});

export const listUsers = tool({
  description: "List all users in the Notion workspace.",
  inputSchema: z.object({}),
  execute: async () => {
    const response = await notion.users.list({});
    return json(
      response.results.map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        ...(u.type === "person" && { email: (u as any).person?.email }),
      })),
    );
  },
});

// ---------------------------------------------------------------------------
// Skill: pages — page CRUD + content (markdown)
// ---------------------------------------------------------------------------

export const createPage = tool({
  description: "Create a Notion page with optional markdown content.",
  inputSchema: z.object({
    parent_type: z.enum(["database_id", "page_id"]).describe("Type of parent"),
    parent_id: z.string().describe("ID of the parent database or page"),
    properties: z
      .record(z.string(), z.any())
      .optional()
      .describe("Page properties (required for database parents). Use Notion property format."),
    content: z
      .string()
      .optional()
      .describe("Markdown content for the page body."),
    icon: z.any().optional().describe("Page icon (emoji or external URL)"),
    cover: z.any().optional().describe("Page cover (external URL)"),
  }),
  execute: async ({ parent_type, parent_id, properties, content, icon, cover }) => {
    const children = content ? markdownToBlocks(content) : undefined;
    const page: any = await notion.pages.create({
      parent: { [parent_type]: parent_id } as any,
      properties: properties ?? {},
      ...(children && { children }),
      ...(icon && { icon }),
      ...(cover && { cover }),
    });
    return json({ id: page.id, url: page.url, created_time: page.created_time });
  },
});

export const updatePage = tool({
  description: "Update a Notion page's properties, icon, cover, or archived status.",
  inputSchema: z.object({
    page_id: z.string().describe("Page ID"),
    properties: z.record(z.string(), z.any()).optional().describe("Properties to update"),
    archived: z.boolean().optional().describe("Set to true to archive the page"),
    icon: z.any().optional().describe("New icon"),
    cover: z.any().optional().describe("New cover"),
  }),
  execute: async ({ page_id, properties, archived, icon, cover }) => {
    const page: any = await notion.pages.update({
      page_id,
      ...(properties && { properties }),
      ...(archived !== undefined && { archived }),
      ...(icon && { icon }),
      ...(cover && { cover }),
    });
    return json({ id: page.id, url: page.url, last_edited_time: page.last_edited_time });
  },
});

export const retrievePageProperty = tool({
  description: "Retrieve a specific property value from a page (useful for paginated properties like relations and rollups).",
  inputSchema: z.object({
    page_id: z.string().describe("Page ID"),
    property_id: z.string().describe("Property ID (from retrieve_page results)"),
  }),
  execute: async ({ page_id, property_id }) => {
    const response = await notion.pages.properties.retrieve({ page_id, property_id });
    return json(response);
  },
});

export const readPageContent = tool({
  description: "Read a page's body content as markdown.",
  inputSchema: z.object({
    page_id: z.string().describe("Page ID"),
  }),
  execute: async ({ page_id }) => {
    const tree = await fetchBlockTree(page_id);
    return blockTreeToMarkdown(tree);
  },
});

export const writePageContent = tool({
  description: "Replace a page's entire body content with new markdown.",
  inputSchema: z.object({
    page_id: z.string().describe("Page ID"),
    markdown: z.string().describe("New markdown content for the page."),
  }),
  execute: async ({ page_id, markdown }) => {
    await deleteAllBlocks(page_id);
    const children = markdownToBlocks(markdown);
    if (children.length > 0) {
      await notion.blocks.children.append({ block_id: page_id, children: children as any });
    }
    return json({ success: true, page_id });
  },
});

export const appendPageContent = tool({
  description: "Append markdown content to the end of a page.",
  inputSchema: z.object({
    page_id: z.string().describe("Page ID"),
    markdown: z.string().describe("Markdown content to append."),
  }),
  execute: async ({ page_id, markdown }) => {
    const children = markdownToBlocks(markdown);
    if (children.length > 0) {
      await notion.blocks.children.append({ block_id: page_id, children: children as any });
    }
    return json({ success: true, page_id });
  },
});

// ---------------------------------------------------------------------------
// Skill: databases — query and manage databases
// ---------------------------------------------------------------------------

export const queryDatabase = tool({
  description: "Query a Notion database with optional filters and sorts.",
  inputSchema: z.object({
    database_id: z.string().describe("Database ID"),
    filter: z.any().optional().describe("Notion filter object"),
    sorts: z.array(z.any()).optional().describe("Array of sort objects"),
    page_size: z.number().optional().default(25).describe("Max results per page (max 100)"),
    start_cursor: z.string().optional().describe("Cursor for pagination"),
  }),
  execute: async ({ database_id, filter, sorts, page_size, start_cursor }) => {
    const response = await notion.dataSources.query({
      data_source_id: database_id,
      ...(filter && { filter }),
      ...(sorts && { sorts }),
      page_size: Math.min(page_size, 100),
      ...(start_cursor && { start_cursor }),
    });
    return json({
      results: response.results.map((r: any) => {
        const props: Record<string, any> = {};
        for (const [key, value] of Object.entries(r.properties as Record<string, any>)) {
          if (value.type === "title") props[key] = richTextToPlain(value.title ?? []);
          else if (value.type === "rich_text") props[key] = richTextToPlain(value.rich_text ?? []);
          else if (value.type === "number") props[key] = value.number;
          else if (value.type === "select") props[key] = value.select?.name;
          else if (value.type === "multi_select") props[key] = value.multi_select?.map((s: any) => s.name);
          else if (value.type === "status") props[key] = value.status?.name;
          else if (value.type === "date") props[key] = value.date;
          else if (value.type === "checkbox") props[key] = value.checkbox;
          else if (value.type === "url") props[key] = value.url;
          else if (value.type === "people") props[key] = value.people?.map((p: any) => p.name ?? p.id);
          else if (value.type === "relation") props[key] = value.relation?.map((rel: any) => rel.id);
          else props[key] = `[${value.type}]`;
        }
        return { id: r.id, url: r.url, properties: props };
      }),
      has_more: response.has_more,
      next_cursor: response.next_cursor,
    });
  },
});

export const createDatabase = tool({
  description: "Create a new Notion database as a child of a page.",
  inputSchema: z.object({
    parent_page_id: z.string().describe("Parent page ID"),
    title: z.string().describe("Database title"),
    properties: z.record(z.string(), z.any()).describe("Property schema (e.g., { Name: { title: {} }, Status: { select: { options: [...] } } })"),
  }),
  execute: async ({ parent_page_id, title, properties }) => {
    const db: any = await notion.databases.create({
      parent: { type: "page_id", page_id: parent_page_id },
      title: plainToRichText(title) as any,
      initial_data_source: { properties },
    });
    return json({ id: db.id, url: db.url, title: richTextToPlain(db.title ?? []) });
  },
});

export const updateDatabase = tool({
  description: "Update a Notion database's title or property schema.",
  inputSchema: z.object({
    database_id: z.string().describe("Database ID"),
    title: z.string().optional().describe("New title"),
    properties: z.record(z.string(), z.any()).optional().describe("Property schema updates"),
  }),
  execute: async ({ database_id, title, properties }) => {
    if (title) {
      await notion.databases.update({
        database_id,
        title: plainToRichText(title) as any,
      });
    }
    if (properties) {
      await notion.dataSources.update({
        data_source_id: database_id,
        properties: properties as any,
      });
    }
    const db: any = await notion.databases.retrieve({ database_id });
    return json({ id: db.id, url: db.url, title: richTextToPlain(db.title ?? []) });
  },
});

// ---------------------------------------------------------------------------
// Skill: comments
// ---------------------------------------------------------------------------

export const createComment = tool({
  description: "Create a comment on a page or in a discussion thread.",
  inputSchema: z.object({
    parent_type: z.enum(["page_id", "discussion_id"]).describe("Comment target type"),
    parent_id: z.string().describe("Page ID or discussion thread ID"),
    text: z.string().describe("Comment text"),
  }),
  execute: async ({ parent_type, parent_id, text }) => {
    const comment: any = await notion.comments.create({
      [parent_type]: parent_id,
      rich_text: plainToRichText(text),
    } as any);
    return json({ id: comment.id, created_time: comment.created_time });
  },
});

export const listComments = tool({
  description: "List comments on a page.",
  inputSchema: z.object({
    block_id: z.string().describe("Page ID"),
    page_size: z.number().optional().default(25).describe("Max results (max 100)"),
    start_cursor: z.string().optional().describe("Cursor for pagination"),
  }),
  execute: async ({ block_id, page_size, start_cursor }) => {
    const response = await notion.comments.list({
      block_id,
      page_size: Math.min(page_size, 100),
      ...(start_cursor && { start_cursor }),
    });
    return json({
      results: response.results.map((c: any) => ({
        id: c.id,
        text: richTextToPlain(c.rich_text ?? []),
        created_time: c.created_time,
        created_by: c.created_by?.id,
        discussion_id: c.discussion_id,
      })),
      has_more: response.has_more,
      next_cursor: response.next_cursor,
    });
  },
});
