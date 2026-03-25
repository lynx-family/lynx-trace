# Contributing Guide

Thank you for your interest in contributing to the Trace Analysis project!

## Development Setup

### Prerequisites

- Node.js v18+
- pnpm v8+
- Python 3.8+ (for agent evaluation)

### Installation

```bash
cd trace_analysis
pnpm install
```

### Build

```bash
# Build all packages
pnpm run build

# Or build individual packages
cd packages/trace_query && pnpm run build
cd packages/agent && pnpm run build
cd packages/scripts && pnpm run build
```

## Project Structure

```
trace_analysis/
├── agent_evaluation/     # Python-based evaluation framework
├── docs/                 # Documentation and analyzer prompts
│   ├── references/       # Analyzer documentation (source of truth)
│   └── templates/        # Skill templates
├── packages/
│   ├── agent/            # AI-powered trace analysis agent
│   ├── scripts/          # Build and generation scripts
│   └── trace_query/      # Trace query library and CLI
└── skills/               # Auto-generated skill files
```

## Auto-Generated Directories

The following directories are **auto-generated** and should not be manually edited:

- `packages/agent/src/prompts/` - Generated from `docs/`
- `skills/` - Generated from `docs/`

### How to Update Auto-Generated Files

1. Modify the source files in `docs/`

2. Run the generation scripts:
   ```bash
   cd packages/scripts
   pnpm run generate-skills
   pnpm run generate-prompts
   ```

3. Commit the changes (CI will verify no direct edits to protected paths)

## Making Changes

### Adding a New Analyzer

Analyzers define how the AI agent analyzes specific aspects of trace data. To add a new analyzer:

#### 1. Create Analyzer Documentation

Create a new markdown file in `docs/references/my_analyzer.md`:

```markdown
---
name: my_analyzer
description: Description of what this analyzer does
---

# My Analyzer

## Purpose
Explain the purpose and use cases.

## Analysis Steps
1. Step 1: Query data using available tools
2. Step 2: Analyze the results
3. Step 3: Identify performance issues

## Performance Bottlenecks
List the bottlenecks this analyzer can detect:

| Bottleneck | Condition | Description |
|------------|-----------|-------------|
| bottleneck_1 | duration > X ms | Description |
| bottleneck_2 | condition | Description |

## Output Format
Define the expected output format for this analyzer.
```

#### 2. Generate TypeScript Prompt

```bash
cd packages/scripts
pnpm run generate-prompts
```

This generates `packages/agent/src/prompts/my_analyzer.ts`.

#### 3. Use in Agent Workflow

Update `docs/trace_analysis.md` to reference your analyzer in the workflow.

### Adding a New Trace Query Tool

To add a new query capability to the trace_query package:

#### 1. Create Query Function

Create `packages/trace_query/src/queries/query_my_feature.ts`:

```typescript
import { TraceQuery } from '../utils/trace_query';

export interface MyFeatureResult {
    // Define result type
}

export async function queryMyFeature(
    traceQuery: TraceQuery,
    param1: string,
    param2?: number
): Promise<MyFeatureResult[]> {
    const sql = `
        SELECT *
        FROM slice
        WHERE name LIKE '%${param1}%'
        ${param2 ? `AND depth = ${param2}` : ''}
    `;
    
    const result = await traceQuery.query(sql);
    return result as MyFeatureResult[];
}
```

#### 2. Export from Index

Add to `packages/trace_query/src/index.ts`:

```typescript
export { queryMyFeature } from './queries/query_my_feature';
export type { MyFeatureResult } from './queries/query_my_feature';
```

#### 3. Add CLI Command

Add to `packages/trace_query/src/cli/index.ts`:

```typescript
program
    .command('my-feature')
    .description('Query my feature')
    .option('-p, --param1 <param1>', 'Parameter 1')
    .option('-o, --optional <value>', 'Optional parameter')
    .option('-p, --path <path>', 'Trace file path')
    .action(async (options) => {
        try {
            if (!options.path) {
                console.error('Error: --path is required');
                process.exit(1);
            }
            const traceQuery = new TraceQuery();
            await traceQuery.initProcessor(options.path);
            const result = await queryMyFeature(traceQuery, options.param1, options.optional);
            console.log('Result:', JSON.stringify(result, null, 2));
            await traceQuery.destroyProcessor();
        } catch (error) {
            console.error('Error:', error);
            process.exit(1);
        }
    });
```

#### 4. Add Agent Tool

Create `packages/agent/src/tools/trace_query/query_my_feature.ts`:

```typescript
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { queryMyFeature } from '@lynx-js/trace-query';
import { TraceQuery } from './utils/trace_query';

const schema = z.object({
    param1: z.string().describe('Parameter 1 description'),
    param2: z.number().optional().describe('Optional parameter description'),
});

export function createQueryMyFeatureTool(traceQuery: TraceQuery) {
    return new DynamicStructuredTool({
        name: 'query_my_feature',
        description: 'Query my feature from trace',
        schema,
        func: async ({ param1, param2 }) => {
            const result = await queryMyFeature(traceQuery, param1, param2);
            return JSON.stringify(result, null, 2);
        },
    });
}
```

Export from `packages/agent/src/tools/trace_query/index.ts`.

#### 5. Update Documentation

- Add CLI command to `packages/trace_query/README.md` and `trace_analysis/docs/templates/skill_template.md`
- Add tool to `packages/agent/README.md`
- Add analyzer usage guide if applicable

#### 6. Rebuild

```bash
cd packages/trace_query && pnpm run build
cd ../agent && pnpm run build
cd ../scripts && pnpm run bundle-trace-query
```

## CI/CD Pipelines

The project uses automated pipelines:

| Pipeline | Trigger | Description |
|----------|---------|-------------|
| `generate_prompts_pipeline` | Changes to `docs/` or `trace_query/` | Auto-generates skills and prompts |
| `check_protected_paths` | Pull requests | Verifies no manual edits to auto-generated dirs |

## Code Style

### TypeScript

- Use TypeScript for all new code
- Follow existing naming conventions
- Add type definitions for new functions

## Questions?

Feel free to open an issue for:
- Bug reports
- Feature requests
- Documentation improvements
- Questions about the codebase

## License

By contributing, you agree that your contributions will be licensed under the Apache License Version 2.0.
