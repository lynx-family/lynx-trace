# @lynx-js/trace-analysis-scripts

Utility scripts for generating prompts, skills, and bundling the trace_query package.

## Scripts

| Script | Description |
|--------|-------------|
| `generate-skills` | Generate skill files from documentation templates |
| `generate-prompts` | Generate TypeScript prompts from markdown files |
| `bundle-trace-query` | Bundle trace_query into a standalone JS file |

## Usage

### Generate Skills

Generates `skills/SKILL.md` and copies analyzer documentation:

```bash
pnpm run generate-skills
```

This script:
1. Reads `docs/trace_analysis.md` for skill content
2. Applies the template from `docs/templates/skill_template.md`
3. Copies analyzer docs to `skills/references/`
4. Bundles trace_query and copies to `skills/scripts/`

### Generate Prompts

Generates TypeScript prompt files for the agent:

```bash
pnpm run generate-prompts
```

This script:
1. Reads markdown files from `docs/references/analyzers/`
2. Parses front matter (name, description)
3. Generates TypeScript files in `packages/agent/src/prompts/`

### Bundle Trace Query

Bundles the trace_query package for distribution:

```bash
pnpm run bundle-trace-query
```

Output: `dist/bundles/trace_query.bundle.js`

## Project Structure

```
src/
├── bundle_trace_query.ts    # Webpack bundler script
├── generate_prompts.ts      # Prompt generator
└── generate_skills.ts       # Skill generator
```

## Dependencies

- `gray-matter` - Parse markdown front matter
- `ts-node` - Execute TypeScript directly
- `webpack` - Bundle trace_query

## License

Apache License Version 2.0
