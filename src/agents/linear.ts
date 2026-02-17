import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { join } from "node:path";
import { z } from "zod";
import { attachmentSchema, buildPromptWithAttachments } from "../utils/attachments";
import { createModel } from "../utils/model";
import {
  aggregateIssues,
  createCommentTool,
  createCustomerNeedTool,
  createDocumentTool,
  createInitiativeTool,
  createInitiativeUpdateTool,
  createIssueTool,
  createLoadSkillTool,
  createProjectMilestoneTool,
  createProjectTool,
  createProjectUpdateTool,
  deleteCommentTool,
  deleteIssueTool,
  editCommentTool,
  getBaseToolNames,
  getSkillToolNames,
  listCustomerNeedsTool,
  listInitiativesTool,
  queryInitiativeActivityTool,
  queryInitiativeUpdatesTool,
  queryIssueActivityTool,
  queryIssueViewTool,
  queryProjectActivityTool,
  queryProjectUpdatesTool,
  queryProjectViewTool,
  resolveSystemPrompt,
  retrieveEntities,
  searchEntities,
  setReminderTool,
  suggestPropertyValues,
  transcribeMediaFromAttachment,
  updateCustomerNeedTool,
  updateDocumentTool,
  updateInitiativeTool,
  updateInitiativeUpdateTool,
  updateIssueTool,
  updateProjectMilestoneTool,
  updateProjectTool,
  updateProjectUpdateTool,
} from "../tools/linear";

const systemPromptPath = join(import.meta.dir, "../prompts/linear/SYSTEM.md");

/** Cached system prompt, loaded once on first access. */
let systemPromptCache: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (!systemPromptCache) {
    systemPromptCache = await resolveSystemPrompt(systemPromptPath);
  }
  return systemPromptCache;
}

/** Create a subagent tool for Linear project management, scoped to a Discord user. */
export function createLinearTool(userId: string, recentMessages?: string) {
  return tool({
    description:
      "Interact with Linear for project management. Searches, retrieves, creates, and updates issues, projects, documents, comments, cycles, initiatives, customer requests, labels, teams, and users. Use for any task/ticket/issue/sprint/project-related request.",
    inputSchema: z.object({
      task: z.string().describe("The task to perform in Linear"),
      attachments: z
        .array(attachmentSchema)
        .optional()
        .describe("File attachments from the user's message"),
    }),
    execute: async ({ task, attachments }, { abortSignal }) => {
      const loadedSkills = new Set<string>();
      const baseInstructions = await loadSystemPrompt();
      const instructions = recentMessages
        ? `${baseInstructions}\n\n${recentMessages}`
        : baseInstructions;

      const tools = {
        // Meta
        load_skill: createLoadSkillTool((skill) => loadedSkills.add(skill)),
        // Base read tools
        search_entities: searchEntities,
        retrieve_entities: retrieveEntities,
        suggest_property_values: suggestPropertyValues,
        aggregate_issues: aggregateIssues,
        // Issue tools
        create_issue: createIssueTool,
        update_issue: updateIssueTool,
        delete_issue: deleteIssueTool,
        query_issue_activity: queryIssueActivityTool,
        query_issue_view: queryIssueViewTool,
        // Comment tools
        create_comment: createCommentTool,
        edit_comment: editCommentTool,
        delete_comment: deleteCommentTool,
        // Document tools
        create_document: createDocumentTool,
        update_document: updateDocumentTool,
        // Project tools
        create_project: createProjectTool,
        update_project: updateProjectTool,
        create_project_milestone: createProjectMilestoneTool,
        update_project_milestone: updateProjectMilestoneTool,
        query_project_activity: queryProjectActivityTool,
        query_project_view: queryProjectViewTool,
        // Project update tools
        query_project_updates: queryProjectUpdatesTool,
        create_project_update: createProjectUpdateTool,
        update_project_update: updateProjectUpdateTool,
        // Initiative tools
        create_initiative: createInitiativeTool,
        update_initiative: updateInitiativeTool,
        list_initiatives: listInitiativesTool,
        query_initiative_activity: queryInitiativeActivityTool,
        // Initiative update tools
        query_initiative_updates: queryInitiativeUpdatesTool,
        create_initiative_update: createInitiativeUpdateTool,
        update_initiative_update: updateInitiativeUpdateTool,
        // Reminder tools
        set_reminder: setReminderTool,
        // Customer request tools
        create_customer_need: createCustomerNeedTool,
        update_customer_need: updateCustomerNeedTool,
        list_customer_needs: listCustomerNeedsTool,
        // Media transcription tools
        transcribe_media_from_attachment: transcribeMediaFromAttachment,
      };

      const subagent = new ToolLoopAgent({
        model: createModel(userId),
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
      const prompt = buildPromptWithAttachments(task, attachments);
      const result = await subagent.generate({ prompt, abortSignal });
      return result.text;
    },
  });
}
