# @lynx-js/trace-analysis-agent

An AI-powered agent for analyzing Lynx performance traces using LangGraph.

## Installation

```bash
pnpm add @lynx-js/trace-analysis-agent
```

## Usage

### Programmatic

```typescript
import { TraceAnalysis } from '@lynx-js/trace-analysis-agent';

const result = await TraceAnalysis(
  '/path/to/trace.pftrace',
  {
    model: 'gpt-4o',
    apiKey: 'your-api-key',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1'
  },
  'English'
);

console.log(result);
```

### Test Server

```bash
pnpm run test:server
```

Server starts at `http://localhost:3000`.

#### HTTP API

```bash
POST /trace_analysis
Content-Type: application/json

{
  "tracePath": "/path/to/trace.pftrace",
  "modelConfig": {
    "model": "gpt-4o",
    "apiKey": "your-api-key",
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1"
  },
  "language": "English"
}
```

## Tools

The agent provides comprehensive trace query tools:

| Tool | Description |
|------|-------------|
| `query_by_id` | Query slice by ID |
| `query_by_time_window` | Query slices in time range |
| `query_aggregate` | Aggregate events by name |
| `query_ancestors` | Get ancestor slices |
| `query_descendants` | Get descendant slices |
| `query_flow_events` | Get flow events |
| `query_lynxviews` | Get LynxView instances |
| `query_pipeline_ids` | Get pipeline IDs |
| `query_pipeline_overview_events` | Get pipeline overview |
| `query_trace_metadata` | Get trace metadata |
| `query_by_raw_sql` | Execute raw SQL |

## Project Structure

```
src/
├── agent.ts              # Main agent implementation
├── index.ts              # Public exports
├── middlewares/          # Agent middlewares
│   └── log.ts            # Logging middleware
├── prompts/              # Auto-generated prompts
│   ├── references/       # Reference prompts
│   └── trace_analysis.ts # Main prompt
├── tools/                # Trace query tools
│   ├── trace_query/      # Query implementations
│   └── spawn.ts          # Tool spawning
├── types/                # Type definitions
└── utils/                # Utility functions
```

## Auto-Generated Files

The `prompts/` directory is auto-generated from `docs/references/`. Do not edit manually.

To update prompts:
1. Modify source files in `docs/references/`
2. Run `pnpm run generate-prompts` in `packages/scripts`

## Dependencies

- `@langchain/core` - LangChain core
- `@langchain/langgraph` - Agent graph framework
- `@langchain/openai` - OpenAI integration
- `@langchain/anthropic` - Anthropic integration
- `@langchain/google-genai` - Google AI integration
- `@lynx-js/trace-query` - Trace query library

## License

Apache License Version 2.0
