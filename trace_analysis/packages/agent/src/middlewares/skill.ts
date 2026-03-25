// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { createMiddleware, SystemMessage } from 'langchain';
import { z } from 'zod';

import { AGENT_CONTEXT_SCHEMA } from '../types/context';
import { SkillSchema } from '../types/skill';

type Skill = z.infer<typeof SkillSchema>;

class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  getNames(): string[] {
    return Array.from(this.skills.keys());
  }

  getDescriptions(): string {
    const descriptions: string[] = [];
    for (const [name, skill] of this.skills) {
      descriptions.push(`- **${name}**: ${skill.description}`);
    }
    return descriptions.join('\n');
  }
}

const globalSkillRegistry = new SkillRegistry();

export function registerSkill(skill: Skill): void {
  globalSkillRegistry.register(skill);
}

export function registerSkills(skills: Skill[]): void {
  skills.forEach((skill) => globalSkillRegistry.register(skill));
}

export function getSkillRegistry(): SkillRegistry {
  return globalSkillRegistry;
}

export function getSkillDescriptions(): string {
  return globalSkillRegistry.getDescriptions();
}

export function getSkillNames(): string[] {
  return globalSkillRegistry.getNames();
}

export function getSkill(name: string): Skill | undefined {
  return globalSkillRegistry.get(name);
}

export function createSkillMiddleware(skills: Skill[] = []) {
  registerSkills(skills);

  const skillDescriptions = globalSkillRegistry.getDescriptions();

  const skillsAddendum = `
## Available Skills
${skillDescriptions}
Use the \`load_skill\` tool when you need detailed information about handling a specific type of request. This will provide you with comprehensive instructions, policies, and guidelines for the skill area.
`;

  return createMiddleware({
    name: 'SkillMiddleware',
    contextSchema: AGENT_CONTEXT_SCHEMA,

    wrapModelCall: async (request, handler) => {
      const originalSystemMessage = request.systemMessage;

      if (!originalSystemMessage) {
        const newSystemMessage = new SystemMessage({
          content: skillsAddendum,
        });
        return handler({
          ...request,
          systemMessage: newSystemMessage,
        });
      }

      const originalContent =
        typeof originalSystemMessage.content === 'string'
          ? originalSystemMessage.content
          : originalSystemMessage.content;

      const newContent =
        typeof originalContent === 'string'
          ? originalContent + skillsAddendum
          : [
              ...(Array.isArray(originalContent)
                ? originalContent
                : [{ type: 'text', text: JSON.stringify(originalContent) }]),
              { type: 'text', text: skillsAddendum },
            ];

      const newSystemMessage = new SystemMessage({
        content: newContent,
      });

      return handler({
        ...request,
        systemMessage: newSystemMessage,
      });
    },
  });
}

export const skillMiddleware = createSkillMiddleware;
