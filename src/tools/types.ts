export interface Skill {
  name: string;
  description: string;
  criteria: string;
  instructions: string;
  toolNames: string[];
}

export interface SkillSystemConfig {
  /** Directory containing skill subdirectories, each with a SKILL.md file. */
  skillsDir: string;
  /** Skill directory names to load. */
  skillNames: string[];
  /** Tool names always available without loading any skill. */
  baseToolNames: string[];
}
