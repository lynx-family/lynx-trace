import * as fs from 'fs';
import * as path from 'path';

import matter from 'gray-matter';

const DOCS_DIR = path.resolve(process.cwd(), '../../docs');
const OUTPUT_DIR = path.resolve(process.cwd(), '../../packages/agent/src/prompts');
const PROMPT_TEMPLATE_PATH = path.resolve(DOCS_DIR, 'templates/prompt_template.md');

interface AnalyzerInfo {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
}

function parseFrontMatter(content: string): {
  name: string;
  description: string;
  body: string;
  tools?: string[];
} {
  const result = matter(content);
  const data: any = result.data;
  return {
    name: data.name || '',
    description: data.description || '',
    body: result.content.trim(),
    tools: data.tools,
  };
}

function stringifyWithSingleQuotes(str: string): string {
  const escaped = str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function stringifyWithBackticks(str: string): string {
  const escaped = str.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return `\`${escaped}\``;
}

function parseMarkdown(content: string, filename: string): AnalyzerInfo {
  const { name, description, body, tools } = parseFrontMatter(content);

  return {
    name: name || filename.replace('.md', ''),
    description,
    prompt: body,
    tools,
  };
}

function generateToolsAndSubAgents(info: AnalyzerInfo): string {
  let result = '';
  if (info.tools && info.tools.length > 0) {
    const toolsStr = info.tools.map((t) => stringifyWithSingleQuotes(t)).join(', ');
    result += `  tools: [${toolsStr}],\n`;
  }
  return result;
}

function formatDescriptionForPrompt(description: string): string {
  if (description.includes('\n')) {
    const lines = description.split('\n');
    const indentedLines = lines.map((line) => {
      if (line.trim() === '') return '';
      return '  ' + line;
    });
    return indentedLines.join('\n');
  }
  return '  ' + description;
}

function generatePromptWithTemplate(template: string, name: string, description: string, instruction: string): string {
  const formattedDescription = formatDescriptionForPrompt(description);
  return template
    .replace('{{PROMPT_NAME}}', name)
    .replace('{{PROMPT_DESCRIPTION}}', formattedDescription)
    .replace('{{PROMPT_INSTRUCTION}}', instruction);
}

function main() {
  const summaryPathPath = path.join(OUTPUT_DIR, 'summary.ts');
  let summaryContent: string | null = null;
  if (fs.existsSync(summaryPathPath)) {
    summaryContent = fs.readFileSync(summaryPathPath, 'utf-8');
  }

  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }

  const analyzersDir = path.join(OUTPUT_DIR, 'references');
  fs.mkdirSync(analyzersDir, { recursive: true });

  if (summaryContent) {
    fs.writeFileSync(summaryPathPath, summaryContent);
    console.log('Preserved summary.ts');
  }

  const allAnalyzers: string[] = [];

  const files = fs.readdirSync(path.join(DOCS_DIR, 'references'));
  files.forEach((file) => {
    if (file.endsWith('.md')) {
      const filename = file.replace('.md', '');
      const content = fs.readFileSync(path.join(DOCS_DIR, 'references', file), 'utf-8');
      const info = parseMarkdown(content, file);

      const extraFields = generateToolsAndSubAgents(info);

      const tsContent = `// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Prompt } from '../../types/prompt';

export const prompt: Prompt = {
  name: ${stringifyWithSingleQuotes(info.name)},
  description: ${stringifyWithSingleQuotes(info.description)},
  prompt: \`${info.prompt.replace(/`/g, '\\`')}\`,
${extraFields}};

export default prompt;
`;

      const outputFilename = filename.replace(/-/g, '_');
      fs.writeFileSync(path.join(analyzersDir, `${outputFilename}.ts`), tsContent);
      console.log(`Generated prompt for ${file}`);
      allAnalyzers.push(outputFilename);
    }
  });

  const promptTemplate = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf-8');
  const traceAnalysisContent = fs.readFileSync(path.join(DOCS_DIR, 'trace_analysis.md'), 'utf-8');
  const traceAnalysisInfo = parseMarkdown(traceAnalysisContent, 'trace_analysis.md');

  const traceAnalysisPromptContent = generatePromptWithTemplate(
    promptTemplate,
    traceAnalysisInfo.name,
    traceAnalysisInfo.description,
    traceAnalysisInfo.prompt,
  );

  const traceAnalysisExtraFields = generateToolsAndSubAgents(traceAnalysisInfo);

  const descriptionStr = traceAnalysisInfo.description.includes('\n')
    ? stringifyWithBackticks(traceAnalysisInfo.description)
    : stringifyWithSingleQuotes(traceAnalysisInfo.description);

  const traceAnalysisTsContent = `// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
import { Prompt } from '../types/prompt';

export const prompt: Prompt = {
  name: ${stringifyWithSingleQuotes(traceAnalysisInfo.name)},
  description: ${descriptionStr},
  prompt: ${stringifyWithBackticks(traceAnalysisPromptContent)},
${traceAnalysisExtraFields}};

export default prompt;
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'trace_analysis.ts'), traceAnalysisTsContent);
  console.log(`Generated prompt for trace_analysis.md`);

  const imports = allAnalyzers
    .map((a) => {
      return `import { prompt as ${a} } from './references/${a}';`;
    })
    .join('\n');

  const analyzerPrompts = allAnalyzers
    .map((a) => {
      return `  ${a},`;
    })
    .join('\n');

  const indexContent = `// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

${imports}

export const skills = [
${analyzerPrompts}
];
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.ts'), indexContent);
  console.log('Generated index.ts');
}

main();
