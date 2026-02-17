import {
  LinearClient,
  type InitiativeStatus,
  type InitiativeUpdateHealthType,
  type ProjectUpdateHealthType,
} from "@linear/sdk";
import { experimental_transcribe as transcribe, tool } from "ai";
import { groq } from "@ai-sdk/groq";
import { join } from "node:path";
import { z } from "zod";
import { env } from "../env";
import { createSkillSystem } from "./skills";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const linear = new LinearClient({ apiKey: env.LINEAR_API_KEY });

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const { getBaseToolNames, getSkillToolNames, createLoadSkillTool, resolveSystemPrompt } =
  createSkillSystem({
    skillsDir: join(import.meta.dir, "../prompts/linear/skills"),
    skillNames: [
      "issues",
      "issue-views",
      "projects",
      "project-views",
      "project-updates",
      "initiatives",
      "initiative-updates",
      "documents",
      "reminders",
      "comments",
      "media-transcription",
      "customer-requests",
    ],
    baseToolNames: [
      "load_skill",
      "search_entities",
      "retrieve_entities",
      "suggest_property_values",
      "aggregate_issues",
    ],
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an issue filter object from optional UUID fields. */
function issueFilter(f: {
  teamId?: string;
  projectId?: string;
  assigneeId?: string;
  stateId?: string;
  labelId?: string;
  cycleId?: string;
}) {
  return {
    ...(f.teamId && { team: { id: { eq: f.teamId } } }),
    ...(f.projectId && { project: { id: { eq: f.projectId } } }),
    ...(f.assigneeId && { assignee: { id: { eq: f.assigneeId } } }),
    ...(f.stateId && { state: { id: { eq: f.stateId } } }),
    ...(f.labelId && { labels: { id: { eq: f.labelId } } }),
    ...(f.cycleId && { cycle: { id: { eq: f.cycleId } } }),
  };
}

const json = JSON.stringify;

// ---------------------------------------------------------------------------
// Base read tools (always available)
// ---------------------------------------------------------------------------

export const searchEntities = tool({
  description: "Search Linear entities by keyword (1-5 words).",
  inputSchema: z.object({
    query: z.string(),
    entityType: z.enum([
      "Issue",
      "Project",
      "Document",
      "Initiative",
      "User",
      "Team",
      "Customer",
      "IssueLabel",
    ]),
  }),
  execute: async ({ query, entityType }) => {
    const q = query.toLowerCase();
    switch (entityType) {
      case "Issue": {
        const r = await linear.searchIssues(query);
        return json(
          r.nodes.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, url: i.url })),
        );
      }
      case "Project": {
        const r = await linear.searchProjects(query);
        return json(r.nodes.map((p) => ({ id: p.id, name: p.name, url: p.url })));
      }
      case "Document": {
        const r = await linear.searchDocuments(query);
        return json(r.nodes.map((d) => ({ id: d.id, title: d.title, url: d.url })));
      }
      case "Initiative": {
        const r = await linear.initiatives();
        return json(
          r.nodes
            .filter(
              (i) => i.name.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q),
            )
            .map((i) => ({ id: i.id, name: i.name, status: i.status, url: i.url })),
        );
      }
      case "User": {
        const r = await linear.users();
        return json(
          r.nodes
            .filter((u) => u.name.toLowerCase().includes(q))
            .map((u) => ({ id: u.id, name: u.name, email: u.email })),
        );
      }
      case "Team": {
        const r = await linear.teams();
        return json(
          r.nodes
            .filter((t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
            .map((t) => ({ id: t.id, name: t.name, key: t.key })),
        );
      }
      case "Customer": {
        const r = await linear.customers();
        return json(
          r.nodes
            .filter((c) => c.name.toLowerCase().includes(q))
            .map((c) => ({ id: c.id, name: c.name })),
        );
      }
      case "IssueLabel": {
        const r = await linear.issueLabels();
        return json(
          r.nodes
            .filter((l) => l.name.toLowerCase().includes(q))
            .map((l) => ({ id: l.id, name: l.name })),
        );
      }
    }
  },
});

export const retrieveEntities = tool({
  description: "Fetch full details for entities by ID/identifier/URL (up to 10).",
  inputSchema: z.object({
    entities: z
      .array(
        z.object({
          type: z.enum(["Issue", "Project", "Document", "User", "Team", "Initiative"]),
          id: z.string(),
        }),
      )
      .max(10),
  }),
  execute: async ({ entities }) => {
    const results = await Promise.all(
      entities.map(async ({ type, id }) => {
        switch (type) {
          case "Issue": {
            const i = await linear.issue(id);
            const [state, assignee, team, project, labels] = await Promise.all([
              i.state,
              i.assignee,
              i.team,
              i.project,
              i.labels(),
            ]);
            return {
              id: i.id,
              identifier: i.identifier,
              title: i.title,
              description: i.description,
              priority: i.priority,
              dueDate: i.dueDate,
              url: i.url,
              state: state?.name,
              assignee: assignee?.name,
              team: team?.name,
              project: project?.name,
              labels: labels.nodes.map((l) => l.name),
            };
          }
          case "Project": {
            const p = await linear.project(id);
            const [lead, teams, milestones] = await Promise.all([
              p.lead,
              p.teams(),
              p.projectMilestones(),
            ]);
            return {
              id: p.id,
              name: p.name,
              description: p.description,
              state: p.state,
              url: p.url,
              lead: lead?.name,
              teams: teams.nodes.map((t) => t.name),
              milestones: milestones.nodes.map((m) => ({
                id: m.id,
                name: m.name,
                targetDate: m.targetDate,
              })),
            };
          }
          case "Document": {
            const d = await linear.document(id);
            return { id: d.id, title: d.title, content: d.content?.slice(0, 2000), url: d.url };
          }
          case "User": {
            const u = await linear.user(id);
            return { id: u.id, name: u.name, email: u.email, displayName: u.displayName };
          }
          case "Team": {
            const t = await linear.team(id);
            return { id: t.id, name: t.name, key: t.key, description: t.description };
          }
          case "Initiative": {
            const i = await linear.initiative(id);
            const owner = await i.owner;
            return {
              id: i.id,
              name: i.name,
              description: i.description,
              status: i.status,
              targetDate: i.targetDate,
              url: i.url,
              owner: owner?.name,
            };
          }
        }
      }),
    );
    return json(results);
  },
});

export const suggestPropertyValues = tool({
  description: "Resolve names to IDs for entity fields. Use before create/update.",
  inputSchema: z.object({
    field: z.enum([
      "Issue.assigneeId",
      "Issue.stateId",
      "Issue.labelIds",
      "Issue.teamId",
      "Issue.projectId",
      "Issue.cycleId",
      "Issue.projectMilestoneId",
    ]),
    query: z.string().optional().describe("Filter by name"),
    scope: z
      .object({ type: z.enum(["Team", "Project"]), id: z.string() })
      .optional()
      .describe("Required for stateId (Team), cycleId (Team), projectMilestoneId (Project)"),
  }),
  execute: async ({ field, query, scope }) => {
    const q = query?.toLowerCase();
    const scopeId = scope?.id;

    switch (field) {
      case "Issue.assigneeId": {
        const r = await linear.users();
        const items = q ? r.nodes.filter((u) => u.name.toLowerCase().includes(q)) : r.nodes;
        return json(items.map((u) => ({ id: u.id, name: u.name })));
      }
      case "Issue.stateId": {
        if (!scopeId) return "Team scope required for status lookup";
        const r = await linear.workflowStates({ filter: { team: { id: { eq: scopeId } } } });
        return json(r.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type })));
      }
      case "Issue.labelIds": {
        const r = await linear.issueLabels();
        const items = q ? r.nodes.filter((l) => l.name.toLowerCase().includes(q)) : r.nodes;
        return json(items.map((l) => ({ id: l.id, name: l.name })));
      }
      case "Issue.teamId": {
        const r = await linear.teams();
        return json(r.nodes.map((t) => ({ id: t.id, name: t.name, key: t.key })));
      }
      case "Issue.projectId": {
        const r = await linear.projects();
        return json(r.nodes.map((p) => ({ id: p.id, name: p.name })));
      }
      case "Issue.cycleId": {
        if (!scopeId) return "Team scope required for cycle lookup";
        const r = await linear.cycles({ filter: { team: { id: { eq: scopeId } } } });
        return json(r.nodes.map((c) => ({ id: c.id, name: c.name, number: c.number })));
      }
      case "Issue.projectMilestoneId": {
        if (!scopeId) return "Project scope required for milestone lookup";
        const project = await linear.project(scopeId);
        const r = await project.projectMilestones();
        return json(r.nodes.map((m) => ({ id: m.id, name: m.name, targetDate: m.targetDate })));
      }
    }
  },
});

export const aggregateIssues = tool({
  description: "Aggregated issue counts grouped by a dimension. Returns CSV.",
  inputSchema: z.object({
    groupBy: z.enum(["status", "assignee", "label", "priority", "project", "team"]),
    teamId: z.string().optional(),
    projectId: z.string().optional(),
    assigneeId: z.string().optional(),
    stateId: z.string().optional(),
  }),
  execute: async ({ groupBy, ...filters }) => {
    const issues = await linear.issues({ filter: issueFilter(filters), first: 250 });
    const counts = new Map<string, number>();

    for (const issue of issues.nodes) {
      let keys: string[];
      switch (groupBy) {
        case "status":
          keys = [(await issue.state)?.name ?? "None"];
          break;
        case "assignee":
          keys = [(await issue.assignee)?.name ?? "Unassigned"];
          break;
        case "priority":
          keys = [issue.priorityLabel];
          break;
        case "project":
          keys = [(await issue.project)?.name ?? "None"];
          break;
        case "team":
          keys = [(await issue.team)?.name ?? "None"];
          break;
        case "label": {
          const labels = await issue.labels();
          keys = labels.nodes.length > 0 ? labels.nodes.map((l) => l.name) : ["None"];
          break;
        }
      }
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k},${v}`);
    return [`${groupBy},count`, ...rows].join("\n");
  },
});

// ---------------------------------------------------------------------------
// Issue tools
// ---------------------------------------------------------------------------

const issueFields = {
  title: z.string().optional(),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  stateId: z.string().optional(),
  priority: z.number().optional().describe("0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
  projectId: z.string().optional(),
  projectMilestoneId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  dueDate: z.string().optional().describe("ISO date"),
  cycleId: z.string().optional(),
};

export const createIssueTool = tool({
  description: "Create an issue.",
  inputSchema: z.object({
    ...issueFields,
    title: z.string(),
    teamId: z.string(),
  }),
  execute: async (input) => {
    const payload = await linear.createIssue(input);
    const issue = await payload.issue;
    if (!issue) return "Failed to create issue";
    return json({ id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url });
  },
});

export const updateIssueTool = tool({
  description: "Update an issue (only include fields to change).",
  inputSchema: z.object({ id: z.string(), ...issueFields }),
  execute: async ({ id, ...input }) => {
    const payload = await linear.updateIssue(id, input);
    const issue = await payload.issue;
    if (!issue) return "Failed to update issue";
    return json({ id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url });
  },
});

export const deleteIssueTool = tool({
  description: "Delete an issue.",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const payload = await linear.deleteIssue(id);
    return json({ success: payload.success });
  },
});

export const queryIssueActivityTool = tool({
  description: "Fetch an issue's history and comments.",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const issue = await linear.issue(id);
    const [history, comments] = await Promise.all([issue.history(), issue.comments()]);
    return json({
      history: history.nodes.map((h) => ({
        id: h.id,
        createdAt: h.createdAt,
        updatedDescription: h.updatedDescription,
      })),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body?.slice(0, 500),
        createdAt: c.createdAt,
        url: c.url,
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// Issue view tools
// ---------------------------------------------------------------------------

export const queryIssueViewTool = tool({
  description: "Query issues with filters (list mode, paged).",
  inputSchema: z.object({
    teamId: z.string().optional(),
    projectId: z.string().optional(),
    assigneeId: z.string().optional(),
    stateId: z.string().optional(),
    labelId: z.string().optional(),
    cycleId: z.string().optional(),
    first: z.number().optional().default(25).describe("Max 50"),
  }),
  execute: async ({ first, ...filters }) => {
    const issues = await linear.issues({
      filter: issueFilter(filters),
      first: Math.min(first, 50),
    });
    const results = await Promise.all(
      issues.nodes.map(async (i) => {
        const [state, assignee] = await Promise.all([i.state, i.assignee]);
        return {
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          priority: i.priorityLabel,
          state: state?.name,
          assignee: assignee?.name,
          url: i.url,
        };
      }),
    );
    return json(results);
  },
});

// ---------------------------------------------------------------------------
// Comment tools
// ---------------------------------------------------------------------------

export const createCommentTool = tool({
  description: "Post a Markdown comment on an issue.",
  inputSchema: z.object({
    issueId: z.string(),
    body: z.string(),
  }),
  execute: async (input) => {
    const payload = await linear.createComment(input);
    const comment = await payload.comment;
    if (!comment) return "Failed to create comment";
    return json({ id: comment.id, url: comment.url });
  },
});

export const editCommentTool = tool({
  description: "Edit a comment.",
  inputSchema: z.object({
    id: z.string(),
    body: z.string(),
  }),
  execute: async ({ id, body }) => {
    const payload = await linear.updateComment(id, { body });
    const comment = await payload.comment;
    if (!comment) return "Failed to edit comment";
    return json({ id: comment.id, url: comment.url });
  },
});

export const deleteCommentTool = tool({
  description: "Delete a comment.",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const payload = await linear.deleteComment(id);
    return json({ success: payload.success });
  },
});

// ---------------------------------------------------------------------------
// Document tools
// ---------------------------------------------------------------------------

export const createDocumentTool = tool({
  description: "Create a Markdown document attached to a parent entity.",
  inputSchema: z.object({
    title: z.string(),
    content: z.string().optional(),
    projectId: z.string().optional(),
    initiativeId: z.string().optional(),
    issueId: z.string().optional(),
    cycleId: z.string().optional(),
    teamId: z.string().optional(),
  }),
  execute: async (input) => {
    const payload = await linear.createDocument(input);
    const doc = await payload.document;
    if (!doc) return "Failed to create document";
    return json({ id: doc.id, title: doc.title, url: doc.url });
  },
});

export const updateDocumentTool = tool({
  description: "Update a document's content or move to a different parent.",
  inputSchema: z.object({
    id: z.string(),
    content: z.string().optional(),
    projectId: z.string().optional(),
    initiativeId: z.string().optional(),
    issueId: z.string().optional(),
  }),
  execute: async ({ id, ...input }) => {
    const payload = await linear.updateDocument(id, input);
    const doc = await payload.document;
    if (!doc) return "Failed to update document";
    return json({ id: doc.id, title: doc.title, url: doc.url });
  },
});

// ---------------------------------------------------------------------------
// Project tools
// ---------------------------------------------------------------------------

export const createProjectTool = tool({
  description: "Create a project (requires at least one team).",
  inputSchema: z.object({
    name: z.string(),
    teamIds: z.array(z.string()),
    description: z.string().optional(),
    content: z.string().optional().describe("Markdown"),
    leadId: z.string().optional(),
    memberIds: z.array(z.string()).optional(),
    targetDate: z.string().optional().describe("ISO date"),
    startDate: z.string().optional().describe("ISO date"),
    priority: z.number().optional().describe("0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
  }),
  execute: async (input) => {
    const payload = await linear.createProject(input);
    const project = await payload.project;
    if (!project) return "Failed to create project";
    return json({ id: project.id, name: project.name, url: project.url });
  },
});

export const updateProjectTool = tool({
  description: "Update a project (only include fields to change).",
  inputSchema: z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    content: z.string().optional().describe("Markdown"),
    leadId: z.string().optional(),
    memberIds: z.array(z.string()).optional(),
    targetDate: z.string().optional().describe("ISO date"),
    startDate: z.string().optional().describe("ISO date"),
    priority: z.number().optional().describe("0=None, 1=Urgent, 2=High, 3=Normal, 4=Low"),
  }),
  execute: async ({ id, ...input }) => {
    const payload = await linear.updateProject(id, input);
    const project = await payload.project;
    if (!project) return "Failed to update project";
    return json({ id: project.id, name: project.name, url: project.url });
  },
});

export const createProjectMilestoneTool = tool({
  description: "Create a milestone inside a project.",
  inputSchema: z.object({
    projectId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    targetDate: z.string().optional().describe("ISO date"),
  }),
  execute: async (input) => {
    const payload = await linear.createProjectMilestone(input);
    const milestone = await payload.projectMilestone;
    if (!milestone) return "Failed to create milestone";
    return json({ id: milestone.id, name: milestone.name });
  },
});

export const updateProjectMilestoneTool = tool({
  description: "Update a project milestone.",
  inputSchema: z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    targetDate: z.string().optional().describe("ISO date"),
  }),
  execute: async ({ id, ...input }) => {
    const payload = await linear.updateProjectMilestone(id, input);
    const milestone = await payload.projectMilestone;
    if (!milestone) return "Failed to update milestone";
    return json({ id: milestone.id, name: milestone.name });
  },
});

export const queryProjectActivityTool = tool({
  description: "Fetch a project's history, updates, and comments.",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const project = await linear.project(id);
    const [history, updates, comments] = await Promise.all([
      project.history(),
      project.projectUpdates(),
      project.comments(),
    ]);
    return json({
      history: history.nodes.map((h) => ({ id: h.id, createdAt: h.createdAt })),
      updates: updates.nodes.map((u) => ({
        id: u.id,
        health: u.health,
        createdAt: u.createdAt,
        url: u.url,
      })),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body?.slice(0, 500),
        createdAt: c.createdAt,
        url: c.url,
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// Project view tools
// ---------------------------------------------------------------------------

export const queryProjectViewTool = tool({
  description: "List or count projects.",
  inputSchema: z.object({
    mode: z.enum(["list", "count"]).default("list"),
    first: z.number().optional().default(25).describe("Max 50, list mode only"),
  }),
  execute: async ({ mode, first }) => {
    const projects = await linear.projects({ first: Math.min(first, 50) });
    if (mode === "count") return json({ count: projects.nodes.length });
    const results = await Promise.all(
      projects.nodes.map(async (p) => {
        const lead = await p.lead;
        return { id: p.id, name: p.name, state: p.state, url: p.url, lead: lead?.name };
      }),
    );
    return json(results);
  },
});

// ---------------------------------------------------------------------------
// Project update tools
// ---------------------------------------------------------------------------

const healthSchema = z.enum(["onTrack", "atRisk", "offTrack"]).optional();

export const queryProjectUpdatesTool = tool({
  description: "List project updates (supports pagination).",
  inputSchema: z.object({
    projectId: z.string(),
    first: z.number().optional().default(10),
  }),
  execute: async ({ projectId, first }) => {
    const project = await linear.project(projectId);
    const updates = await project.projectUpdates({ first });
    return json(
      updates.nodes.map((u) => ({
        id: u.id,
        body: u.body?.slice(0, 1000),
        health: u.health,
        createdAt: u.createdAt,
        url: u.url,
      })),
    );
  },
});

export const createProjectUpdateTool = tool({
  description: "Create a project update.",
  inputSchema: z.object({
    projectId: z.string(),
    body: z.string().optional().describe("Markdown"),
    health: healthSchema,
    isDiffHidden: z.boolean().optional(),
  }),
  execute: async ({ projectId, body, health, isDiffHidden }) => {
    const payload = await linear.createProjectUpdate({
      projectId,
      body,
      isDiffHidden,
      health: health as ProjectUpdateHealthType | undefined,
    });
    const update = await payload.projectUpdate;
    if (!update) return "Failed to create project update";
    return json({ id: update.id, url: update.url });
  },
});

export const updateProjectUpdateTool = tool({
  description: "Edit a project update.",
  inputSchema: z.object({
    id: z.string(),
    body: z.string().optional(),
    health: healthSchema,
    isDiffHidden: z.boolean().optional(),
  }),
  execute: async ({ id, health, ...rest }) => {
    const payload = await linear.updateProjectUpdate(id, {
      ...rest,
      health: health as ProjectUpdateHealthType | undefined,
    });
    const update = await payload.projectUpdate;
    if (!update) return "Failed to update project update";
    return json({ id: update.id, url: update.url });
  },
});

// ---------------------------------------------------------------------------
// Initiative tools
// ---------------------------------------------------------------------------

const initiativeStatusSchema = z.enum(["Planned", "Active", "Completed"]).optional();

export const createInitiativeTool = tool({
  description: "Create an initiative.",
  inputSchema: z.object({
    name: z.string(),
    description: z.string().optional(),
    content: z.string().optional().describe("Markdown"),
    ownerId: z.string().optional(),
    status: initiativeStatusSchema,
    targetDate: z.string().optional().describe("ISO date"),
  }),
  execute: async ({ status, ...rest }) => {
    const payload = await linear.createInitiative({
      ...rest,
      status: status as InitiativeStatus | undefined,
    });
    const initiative = await payload.initiative;
    if (!initiative) return "Failed to create initiative";
    return json({ id: initiative.id, name: initiative.name, url: initiative.url });
  },
});

export const updateInitiativeTool = tool({
  description: "Update an initiative (only include fields to change).",
  inputSchema: z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    content: z.string().optional().describe("Markdown"),
    ownerId: z.string().optional(),
    status: initiativeStatusSchema,
    targetDate: z.string().optional().describe("ISO date"),
  }),
  execute: async ({ id, status, ...rest }) => {
    const payload = await linear.updateInitiative(id, {
      ...rest,
      status: status as InitiativeStatus | undefined,
    });
    const initiative = await payload.initiative;
    if (!initiative) return "Failed to update initiative";
    return json({ id: initiative.id, name: initiative.name, url: initiative.url });
  },
});

export const listInitiativesTool = tool({
  description: "List all initiatives.",
  inputSchema: z.object({}),
  execute: async () => {
    const r = await linear.initiatives();
    return json(
      r.nodes.map((i) => ({
        id: i.id,
        name: i.name,
        status: i.status,
        targetDate: i.targetDate,
        url: i.url,
      })),
    );
  },
});

export const queryInitiativeActivityTool = tool({
  description: "Fetch an initiative's history.",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const initiative = await linear.initiative(id);
    const history = await initiative.history();
    return json({ history: history.nodes.map((h) => ({ id: h.id, createdAt: h.createdAt })) });
  },
});

// ---------------------------------------------------------------------------
// Initiative update tools
// ---------------------------------------------------------------------------

export const queryInitiativeUpdatesTool = tool({
  description: "List initiative updates (supports pagination).",
  inputSchema: z.object({
    initiativeId: z.string(),
    first: z.number().optional().default(10),
  }),
  execute: async ({ initiativeId, first }) => {
    const initiative = await linear.initiative(initiativeId);
    const updates = await initiative.initiativeUpdates({ first });
    return json(
      updates.nodes.map((u) => ({
        id: u.id,
        body: u.body?.slice(0, 1000),
        health: u.health,
        createdAt: u.createdAt,
        url: u.url,
      })),
    );
  },
});

export const createInitiativeUpdateTool = tool({
  description: "Create an initiative update.",
  inputSchema: z.object({
    initiativeId: z.string(),
    body: z.string().optional().describe("Markdown"),
    health: healthSchema,
    isDiffHidden: z.boolean().optional(),
  }),
  execute: async ({ initiativeId, body, health, isDiffHidden }) => {
    const payload = await linear.createInitiativeUpdate({
      initiativeId,
      body,
      isDiffHidden,
      health: health as InitiativeUpdateHealthType | undefined,
    });
    const update = await payload.initiativeUpdate;
    if (!update) return "Failed to create initiative update";
    return json({ id: update.id, url: update.url });
  },
});

export const updateInitiativeUpdateTool = tool({
  description: "Edit an initiative update.",
  inputSchema: z.object({
    id: z.string(),
    body: z.string().optional(),
    health: healthSchema,
    isDiffHidden: z.boolean().optional(),
  }),
  execute: async ({ id, health, ...rest }) => {
    const payload = await linear.updateInitiativeUpdate(id, {
      ...rest,
      health: health as InitiativeUpdateHealthType | undefined,
    });
    const update = await payload.initiativeUpdate;
    if (!update) return "Failed to update initiative update";
    return json({ id: update.id, url: update.url });
  },
});

// ---------------------------------------------------------------------------
// Reminder tools
// ---------------------------------------------------------------------------

export const setReminderTool = tool({
  description: "Set a reminder on an issue at a specified time.",
  inputSchema: z.object({
    issueId: z.string(),
    reminderAt: z.string().describe("ISO 8601 datetime"),
  }),
  execute: async ({ issueId, reminderAt }) => {
    const payload = await linear.issueReminder(issueId, new Date(reminderAt));
    const issue = await payload.issue;
    if (!issue) return "Failed to set reminder";
    return json({ id: issue.id, identifier: issue.identifier, url: issue.url });
  },
});

// ---------------------------------------------------------------------------
// Customer request tools
// ---------------------------------------------------------------------------

export const createCustomerNeedTool = tool({
  description: "Create a customer request attached to an issue or project.",
  inputSchema: z.object({
    issueId: z.string().optional(),
    body: z.string().optional(),
    priority: z.number().optional().describe("0=Not important, 1=Important"),
    customerId: z.string().optional(),
    projectId: z.string().optional(),
  }),
  execute: async (input) => {
    const payload = await linear.createCustomerNeed(input);
    const need = await payload.need;
    if (!need) return "Failed to create customer need";
    return json({ id: need.id });
  },
});

export const updateCustomerNeedTool = tool({
  description: "Update a customer request.",
  inputSchema: z.object({
    id: z.string(),
    body: z.string().optional(),
    priority: z.number().optional().describe("0=Not important, 1=Important"),
    customerId: z.string().optional(),
    issueId: z.string().optional(),
    projectId: z.string().optional(),
  }),
  execute: async ({ id, ...input }) => {
    const payload = await linear.updateCustomerNeed(id, input);
    return json({ success: payload.success });
  },
});

export const listCustomerNeedsTool = tool({
  description: "List customer requests.",
  inputSchema: z.object({}),
  execute: async () => {
    const r = await linear.customerNeeds();
    return json(r.nodes.map((n) => ({ id: n.id, priority: n.priority, createdAt: n.createdAt })));
  },
});

// ---------------------------------------------------------------------------
// Media transcription tools
// ---------------------------------------------------------------------------

export const transcribeMediaFromAttachment = tool({
  description: "Transcribe an audio/video attachment from its asset URL and return the transcript.",
  inputSchema: z.object({
    assetUrl: z.string().describe("The media file's asset URL"),
    context: z
      .string()
      .optional()
      .describe("Extra info to help transcription (e.g., 'customer demo call about billing bug')"),
  }),
  execute: async ({ assetUrl, context }) => {
    const result = await transcribe({
      model: groq.transcription("whisper-large-v3-turbo"),
      audio: new URL(assetUrl),
      providerOptions: {
        groq: {
          ...(context && { prompt: context }),
        },
      },
    });
    return json({
      text: result.text,
      durationInSeconds: result.durationInSeconds,
      segments: result.segments,
    });
  },
});
