// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { tool } from 'langchain';
import { z } from 'zod';

import { registerSkills, getSkill, getSkillNames, getSkillDescriptions } from '../middlewares/skill';
import { skills } from '../prompts';
import { SkillSchema } from '../types/skill';

type Skill = z.infer<typeof SkillSchema>;

const initializedSkills: Skill[] = skills.map((skill) => ({
  name: skill.name,
  description: skill.description,
  content: skill.prompt,
}));

registerSkills(initializedSkills);

export function createSkillTool() {
  const skillDescriptions = getSkillDescriptions();
  return tool(
    async ({ name }) => {
      const skill = getSkill(name);
      if (!skill) {
        return JSON.stringify({
          error: `Skill '${name}' not found. Available skills: ${getSkillNames().join(', ')}`,
        });
      }
      return skill.content;
    },
    {
      name: 'load_skill',
      description: `Load a specialized skill file on-demand. Available skills:\n${skillDescriptions}`,
      schema: z.object({
        name: z.string().describe('The name of the skill file to load.'),
      }),
    },
  );
}

export const skillTool = createSkillTool();

export { getSkillNames, getSkillDescriptions, getSkill };
