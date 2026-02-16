import { tool } from "ai";
import matter from "gray-matter";
import { join } from "node:path";
import { z } from "zod";
import type { Skill, SkillSystemConfig } from "./types";

/** Load a single skill from its SKILL.md file. */
async function loadSkillFile(skillsDir: string, skillName: string): Promise<Skill> {
  const raw = await Bun.file(join(skillsDir, skillName, "SKILL.md")).text();
  const { data, content } = matter(raw);
  return {
    name: (data.name as string) ?? skillName,
    description: (data.description as string) ?? "",
    criteria: (data.criteria as string) ?? "",
    instructions: content.trimStart(),
    toolNames: data.tools
      ? String(data.tools)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
  };
}

/**
 * Create a skill system for an agent.
 *
 * Reads SKILL.md files (with frontmatter) from `skillsDir`, caches them,
 * and returns helpers to query metadata, resolve tool names, and build
 * a `load_skill` tool with progressive disclosure via `activeTools`.
 *
 * @example
 * ```ts
 * const skills = createSkillSystem({
 *   skillsDir: join(import.meta.dir, "../prompts/myagent/skills"),
 *   skillNames: ["search", "crud"],
 *   baseToolNames: ["load_skill", "search"],
 * });
 * ```
 */
export function createSkillSystem(config: SkillSystemConfig) {
  const { skillsDir, skillNames, baseToolNames } = config;

  let skillCache: Record<string, Skill> | null = null;

  async function getSkills(): Promise<Record<string, Skill>> {
    if (!skillCache) {
      const entries = await Promise.all(
        skillNames.map(async (name) => [name, await loadSkillFile(skillsDir, name)] as const),
      );
      skillCache = Object.fromEntries(entries);
    }
    return skillCache;
  }

  /** Get the tool names that are always active (no skill required). */
  function getBaseToolNames(): string[] {
    return baseToolNames;
  }

  /** Build the `- name: description` metadata block for a system prompt. */
  async function getSkillMetadata(): Promise<string> {
    const skills = await getSkills();
    return Object.values(skills)
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
  }

  /** Get the tool names unlocked by a given skill. */
  async function getSkillToolNames(skill: string): Promise<string[]> {
    const skills = await getSkills();
    return skills[skill]?.toolNames ?? [];
  }

  /**
   * Create a `load_skill` tool that calls `onLoad` when a skill is loaded.
   * The tool returns the full skill bundle (description, criteria, instructions, tools)
   * wrapped in `<loaded-skill>` XML so the model treats it as authoritative guidance.
   */
  function createLoadSkillTool(onLoad: (skill: string) => void) {
    return tool({
      description:
        "Load a skill to enable its tools and guidance for this session. Call this BEFORE performing a task. Available skills: " +
        skillNames.join(", "),
      inputSchema: z.object({
        skill: z
          .enum(skillNames as [string, ...string[]])
          .describe("The skill to load"),
      }),
      execute: async ({ skill }): Promise<string> => {
        const skills = await getSkills();
        const s = skills[skill];
        if (!s) return `Unknown skill: ${skill}. Available: ${skillNames.join(", ")}`;
        onLoad(skill);
        const toolList = s.toolNames.length > 0 ? s.toolNames.join(", ") : "none";
        return [
          `Loaded skill: ${s.name}`,
          "",
          `<loaded-skill name="${s.name}">`,
          `<description>${s.description}</description>`,
          `<criteria>${s.criteria}</criteria>`,
          `<instructions>`,
          s.instructions,
          `</instructions>`,
          `<tools>${toolList}</tools>`,
          `</loaded-skill>`,
        ].join("\n");
      },
    });
  }

  /**
   * Load a system prompt template from a markdown file and replace
   * the `{{SKILL_METADATA}}` placeholder with the skill list.
   */
  async function resolveSystemPrompt(templatePath: string): Promise<string> {
    const template = await Bun.file(templatePath).text();
    const metadata = await getSkillMetadata();
    return template.replace("{{SKILL_METADATA}}", metadata);
  }

  return {
    getBaseToolNames,
    getSkillMetadata,
    getSkillToolNames,
    createLoadSkillTool,
    resolveSystemPrompt,
  };
}
