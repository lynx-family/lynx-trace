---
name: {{SKILL_NAME}}
description: |
{{SKILL_DESCRIPTION}}
---

{{SKILL_INSTRUCTION}}

## Appendix

### Tool Usage

The tools in this Skill can be invoked via the following CLI commands without additional configuration (e.g., MCP):

#### Trace Query Commands

| Command | Description |
|---------|-------------|
| `id` | Execute trace query by slice ID |
| `time-window` | Execute time window query |
| `aggregate` | Execute aggregate query |
| `ancestors` | Query ancestors of a slice |
| `descendants` | Query descendants of a slice |
| `flow` | Query flow events of a slice |
| `metadata` | Query trace metadata |
| `lynxview` | Query LynxView instances |
| `pipeline` | Query pipeline IDs for an instance |
| `pipeline-overview` | Query pipeline overview events |
| `metrics` | Query Lynx rendering metrics |
| `threads` | Query all threads from trace |
| `long-tasks` | Query long tasks on a specific track |
| `sql` | Execute raw SQL query |

**Before using `sql`, please read the [sql-guide](./references/sql-guide.md) guide first.**

#### Trace Recording Commands

| Command | Description |
|---------|-------------|
| `list-clients` | List available clients (connected apps) |
| `start` | Start recording a trace |
| `end` | Stop recording and get a stream handle |
| `readData` | Read and save the trace data from a stream |

######## Common Options

All trace query commands require the `-p, --path <path>` option to specify the trace file path (can be a URL or local file path).

Trace recording commands support the following options:
- `-c, --client <clientId>`: Client ID (required)
- For `start`: `--enable-systrace`, `--js-profile-interval <interval>`, `--js-profile-type <type>`
- For `readData`: `-s, --stream <stream>` (required), `-o, --output <path>` (output file path)

#### Usage Examples

##### Trace Query Examples

- **Show help:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs --help
  ```

- **Query by slice ID:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs id --id 381 --path "https://example.com/trace.pftrace"
  ```

- **Query by time window:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs time-window --start 27110135.548086 --end 27110139 --path "https://example.com/trace.pftrace"
  ```

- **Query aggregate:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs aggregate --start 27110135.548086 --end 27110139 --name "TemplateName" --path "https://example.com/trace.pftrace"
  ```

- **Query ancestors/descendants:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs ancestors --id 4894 --path "https://example.com/trace.pftrace"
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs descendants --id 4894 --path "https://example.com/trace.pftrace"
  ```

- **Query flow events:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs flow --id 6808 --path "https://example.com/trace.pftrace"
  ```

- **Query trace metadata:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs metadata --path "https://example.com/trace.pftrace"
  ```

- **Query LynxView instances:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs lynxview --path "https://example.com/trace.pftrace"
  ```

- **Query pipeline IDs:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs pipeline --instance-id "instance_123" --path "https://example.com/trace.pftrace"
  ```

- **Query pipeline overview:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs pipeline-overview --pipeline-id "pipeline_456" --path "https://example.com/trace.pftrace"
  ```

- **Query metrics:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs metrics --path "https://example.com/trace.pftrace"
  ```

- **Query threads:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs threads --path "https://example.com/trace.pftrace"
  ```

- **Query long tasks:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs long-tasks --track 6 --duration 16 --path "https://example.com/trace.pftrace"
  ```

- **Execute raw SQL query:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs sql --query "SELECT * FROM slice LIMIT 10" --path "https://example.com/trace.pftrace"
  ```

- **Using local file path:**

  ```bash
  $ node <path_to_the_skill>/scripts/trace_query.bundle.cjs metadata --path "/path/to/local/trace.pftrace"
  ```