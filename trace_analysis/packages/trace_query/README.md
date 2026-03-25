# @lynx-js/trace-query

A library for querying trace data using the Perfetto trace processor.

## Installation

```bash
pnpm add @lynx-js/trace-query
```

## Usage

### Programmatic

```typescript
import { TraceQuery, queryById, queryByTimeWindow } from '@lynx-js/trace-query';

const traceQuery = new TraceQuery();
await traceQuery.initProcessor('/path/to/trace.pftrace');

// Query by ID
const slice = await queryById(traceQuery, 123);

// Query by time window
const slices = await queryByTimeWindow(traceQuery, 1000, 2000);

await traceQuery.destroyProcessor();
```

### CLI

```bash
# Show help
node dist/cli/index.js --help

# Query by slice ID
node dist/cli/index.js id --id 381 --path "https://example.com/trace.pftrace"

# Query by time window
node dist/cli/index.js time-window --start 1000 --end 2000 --path "/path/to/trace.pftrace"

# Query metadata
node dist/cli/index.js metadata --path "/path/to/trace.pftrace"

# Execute raw SQL
node dist/cli/index.js sql --query "SELECT * FROM slice LIMIT 10" --path "/path/to/trace.pftrace"

# Query metrics
node dist/cli/index.js metrics --path "/path/to/trace.pftrace"

# Query threads
node dist/cli/index.js threads --path "/path/to/trace.pftrace"

# Query long tasks (threshold: 16ms)
node dist/cli/index.js long-tasks --track 6 --duration 16 --path "/path/to/trace.pftrace"
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `id` | Query slice by ID |
| `time-window` | Query slices within a time range |
| `aggregate` | Aggregate events by name |
| `ancestors` | Query ancestor slices |
| `descendants` | Query descendant slices |
| `flow` | Query flow events |
| `metadata` | Query trace metadata |
| `lynxview` | Query LynxView instances |
| `pipeline` | Query pipeline IDs |
| `pipeline-overview` | Query pipeline overview events |
| `metrics` | Query Lynx rendering metrics |
| `threads` | Query all threads |
| `long-tasks` | Query long tasks on a track |
| `sql` | Execute raw SQL query |

All commands require `-p, --path <path>` to specify the trace file (URL or local path).

## Query Methods

| Method | Description |
|--------|-------------|
| `queryById` | Query a slice by its ID |
| `queryByTimeWindow` | Query slices within a time window |
| `queryAggregate` | Aggregate events by name pattern |
| `queryAncestors` | Get ancestor slices |
| `queryDescendants` | Get descendant slices |
| `queryFlowEvents` | Get flow events for a slice |
| `queryLynxView` | Get LynxView instances |
| `queryPipelineIds` | Get pipeline IDs for an instance |
| `queryPipelineOverviewEvents` | Get pipeline overview events |
| `queryTraceMetadata` | Get trace metadata |
| `queryMetrics` | Get Lynx rendering metrics |
| `queryThreads` | Get all threads with track IDs |
| `queryLongTasks` | Get long tasks exceeding duration threshold |
| `queryByRawSql` | Execute raw SQL |

## Project Structure

```
src/
├── cli/                  # CLI implementation
│   └── index.ts          # Command definitions
├── queries/              # Query implementations
├── trace_processor/      # Trace processor integration
├── types/                # Type definitions
└── utils/                # Utility functions
```

## License

Apache License Version 2.0
