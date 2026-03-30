# Trace Analysis

A comprehensive solution for analyzing Lynx performance traces, including tools for querying trace data, generating AI-powered analysis, and evaluating trace analysis agents.

## Project Structure

```
trace_analysis/
├── agent_evaluation/     # Agent evaluation framework
├── docs/                 # Documentation and analyzer prompts
│   ├── references/       # Analyzer documentation
│   └── templates/        # Skill templates
├── packages/
│   ├── agent/            # AI-powered trace analysis agent
│   ├── scripts/          # Build and generation scripts
│   └── trace_query/      # Trace query library and CLI
└── skills/               # Auto-generated skill files
```

## Packages

### [@lynx-js/trace-query](./packages/trace_query/README.md)

A library for querying trace data using Perfetto trace processor.

- Multiple query methods (by ID, time window, aggregation, etc.)
- CLI interface for interactive querying
- TypeScript support

### [@lynx-js/trace-analysis-agent](./packages/agent/README.md)

An AI-powered agent for analyzing trace data.

- LangGraph-based agent architecture
- Multiple AI model support (OpenAI, Anthropic, Google)
- Comprehensive trace query tools

### [@trace-analysis/scripts](./packages/scripts/README.md)

Utility scripts for the trace analysis project.

- `generate-skills`: Generate skill files from documentation
- `generate-prompts`: Generate TypeScript prompts from markdown
- `bundle-trace-query`: Bundle trace_query for distribution

### [MCP Server](./packages/mcp-server/README.md)

Model Context Protocol server implementation.

## Getting Started

### Prerequisites

- Node.js v18+
- pnpm v8+

### Installation

```bash
cd trace_analysis
pnpm install
```

### Build

```bash
pnpm run build
```

### Generate Skills and Prompts

```bash
cd packages/scripts
pnpm run generate-skills
pnpm run generate-prompts
```

## CI/CD

The project uses automated pipelines:

- **generate_prompts_pipeline**: Auto-generates skills and prompts when `docs/` or `trace_query/` changes
- **check_protected_paths**: Prevents manual edits to auto-generated directories

## Auto-Generated Directories

The following directories are auto-generated and should not be manually edited:

- `skills/` - Generated from `docs/`
- `packages/agent/src/prompts/` - Generated from `docs/`

To update these, modify the source files in `docs/` and run the generation scripts.

## License

Apache License Version 2.0
