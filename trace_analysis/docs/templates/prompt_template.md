
{{PROMPT_INSTRUCTION}}

## Appendix
## Tools
### trace query tools

The tools below can be invoked to query trace data:

#### Available Tools

| Tool | Description |
|------|-------------|
| `query_metrics` | Query Lynx rendering metrics (First Frame, Update stages) |
| `query_by_time_window` | Query all trace events within a time range |
| `query_aggregate` | Aggregate query for events matching a pattern |
| `query_ancestors` | Query ancestor slices of a given slice |
| `query_descendants` | Query descendant slices of a given slice |
| `query_flow_events` | Query flow events connected to a slice |
| `query_by_id` | Query a single slice by its ID |
| `query_trace_metadata` | Query trace metadata (platform, app info) |
| `query_threads` | Query all threads from trace |
| `query_long_tasks` | Query long tasks exceeding a duration threshold |
| `query_by_raw_sql` | Execute raw SQL query on trace database |

**Note: Before using `query_by_raw_sql`, please read the [sql-guide](./references/sql-guide.md) guide first.**
