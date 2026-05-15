import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import matter from 'gray-matter';

const DOCS_DIR = path.resolve(__dirname, '../../..', 'docs');
const SKILL_TEMPLATE_PATH = path.resolve(DOCS_DIR, 'templates/skill_template.md');
const SKILLS_ROOT_DIR = path.resolve(__dirname, '../../..', 'skills');
const REFERENCES_DIR = path.resolve(DOCS_DIR, 'references');

function parseFrontMatter(content: string): { name: string; description: string; body: string } {
  const result = matter(content);
  const data: any = result.data;
  return {
    name: data.name || '',
    description: data.description || '',
    body: result.content.trim(),
  };
}

function formatDescription(description: string): string {
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

function generateSkill(
  sourceFile: string,
  outputDir: string,
  bundles: string[],
  copyReferences: boolean = false,
  useTemplate: boolean = true,
) {
  console.log(`\nGenerating skill from ${sourceFile} to ${outputDir}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  } else {
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      if (file === 'references') {
        fs.rmSync(path.join(outputDir, file), { recursive: true, force: true });
      }
    }
  }

  const sourceContent = fs.readFileSync(path.join(DOCS_DIR, sourceFile), 'utf-8');
  let skillContent: string;

  if (useTemplate) {
    const template = fs.readFileSync(SKILL_TEMPLATE_PATH, 'utf-8');
    const { name, description, body } = parseFrontMatter(sourceContent);
    const formattedDescription = formatDescription(description);

    skillContent = template
      .replace('{{SKILL_NAME}}', name)
      .replace('{{SKILL_DESCRIPTION}}', formattedDescription)
      .replace('{{SKILL_INSTRUCTION}}', body);
  } else {
    skillContent = sourceContent;
  }

  fs.writeFileSync(path.join(outputDir, 'SKILL.md'), skillContent);
  console.log(`Generated SKILL.md in ${outputDir}`);

  if (copyReferences) {
    const refDir = path.join(outputDir, 'references');
    if (!fs.existsSync(refDir)) {
      fs.mkdirSync(refDir, { recursive: true });
    }

    if (fs.existsSync(REFERENCES_DIR)) {
      const analyzerFiles = fs.readdirSync(REFERENCES_DIR);
      analyzerFiles.forEach((file) => {
        if (file.endsWith('.md')) {
          const sourcePath = path.join(REFERENCES_DIR, file);
          const destPath = path.join(refDir, file);
          fs.copyFileSync(sourcePath, destPath);
          console.log(`Copied analyzer: ${file}`);
        }
      });
    } else {
      console.log('References directory not found:', REFERENCES_DIR);
    }
  }

  if (bundles.length > 0) {
    const scriptsDestDir = path.join(outputDir, 'scripts');

    if (!fs.existsSync(scriptsDestDir)) {
      fs.mkdirSync(scriptsDestDir, { recursive: true });
    }

    bundles.forEach((bundleFileName) => {
      const bundleSourcePath = path.resolve(__dirname, '..', 'dist', 'bundles', bundleFileName);
      const bundleDestPath = path.join(scriptsDestDir, bundleFileName);
      if (fs.existsSync(bundleSourcePath)) {
        fs.copyFileSync(bundleSourcePath, bundleDestPath);
        console.log(`Copied ${bundleFileName} to: ${bundleDestPath}`);
      } else {
        console.error('Bundle file not found:', bundleSourcePath);
        process.exit(1);
      }
    });
  }
}

function main() {
  console.log('Executing bundle...');
  try {
    execSync('pnpm run bundle-trace-query', {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    console.log('Bundle completed successfully!');
  } catch (error: any) {
    console.error('Error executing bundle!');
    if (error.stdout) {
      console.error('stdout:', error.stdout.toString());
    }
    if (error.stderr) {
      console.error('stderr:', error.stderr.toString());
    }
    console.error('Error:', error);
    process.exit(1);
  }

  generateSkill(
    'trace_analysis.md',
    path.join(SKILLS_ROOT_DIR, 'trace-analysis-skill'),
    ['trace_query.bundle.cjs', 'shared.bundle.cjs'],
    true,
    true,
  );

  generateSkill(
    'trace_record.md',
    path.join(SKILLS_ROOT_DIR, 'trace-record-skill'),
    ['trace_record.bundle.cjs', 'shared.bundle.cjs'],
    false,
    false,
  );

  console.log('\nAll skills generated successfully!');
}

main();
