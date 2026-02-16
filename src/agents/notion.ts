import { ToolLoopAgent, gateway, stepCountIs, tool } from "ai";
import { join } from "node:path";
import { z } from "zod";
import {
  appendPageContent,
  createComment,
  createDatabase,
  createPage,
  listComments,
  listUsers,
  queryDatabase,
  readPageContent,
  retrieveDatabase,
  retrievePage,
  retrievePageProperty,
  searchNotion,
  updateDatabase,
  updatePage,
  writePageContent,
} from "../tools/notion";
import {
  createLoadSkillTool,
  getBaseToolNames,
  getSkillToolNames,
  resolveSystemPrompt,
} from "../tools/notion";

const systemPromptPath = join(import.meta.dir, "../prompts/notion/SYSTEM.md");

/** Cached system prompt, loaded once on first access. */
let systemPromptCache: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (!systemPromptCache) {
    systemPromptCache = await resolveSystemPrompt(systemPromptPath);
  }
  return systemPromptCache;
}

/** Subagent tool for Notion workspace management. */
export const notionTool = tool({
  description:
    "Manage Notion pages, databases, and content. Searches, retrieves, creates, and updates pages, databases, and comments. Use for any docs/wiki/database/workspace-related request.",
  inputSchema: z.object({
    task: z.string().describe("The task to perform in Notion"),
  }),
  execute: async ({ task }, { abortSignal }) => {
    const loadedSkills = new Set<string>();
    const instructions = await loadSystemPrompt();

    const tools = {
      // Meta
      load_skill: createLoadSkillTool((skill) => loadedSkills.add(skill)),
      // Base read tools
      search_notion: searchNotion,
      retrieve_page: retrievePage,
      retrieve_database: retrieveDatabase,
      list_users: listUsers,
      // Page tools
      create_page: createPage,
      update_page: updatePage,
      retrieve_page_property: retrievePageProperty,
      read_page_content: readPageContent,
      write_page_content: writePageContent,
      append_page_content: appendPageContent,
      // Database tools
      query_database: queryDatabase,
      create_database: createDatabase,
      update_database: updateDatabase,
      // Comment tools
      create_comment: createComment,
      list_comments: listComments,
    };

    const subagent = new ToolLoopAgent({
      model: gateway("anthropic/claude-sonnet-4"),
      instructions,
      tools,
      prepareStep: async () => {
        // Base tools are always active; skill tools unlock after load_skill
        const active = new Set<string>(getBaseToolNames());
        for (const skill of loadedSkills) {
          for (const name of await getSkillToolNames(skill)) {
            active.add(name);
          }
        }
        return { activeTools: [...active] as (keyof typeof tools)[] };
      },
      stopWhen: stepCountIs(15),
    });
    const result = await subagent.generate({ prompt: task, abortSignal });
    return result.text;
  },
});
