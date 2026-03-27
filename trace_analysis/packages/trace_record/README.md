# @byted-lynx/trace-record

A library and CLI tool for recording trace data for Lynx applications.

## Installation

```bash
pnpm add @byted-lynx/trace-record
```

## Usage

### Programmatic

```typescript
import { TraceRecord } from '@byted-lynx/trace-record';

// Initialize trace recorder
const traceRecord = new TraceRecord({ outputDir: './traces' });
await traceRecord.init();

// Start recording
await traceRecord.start('my_trace');

// Write data
await traceRecord.writeData([{ event: 'click', timestamp: Date.now() }]);

// Stop recording
const tracePath = await traceRecord.end();
console.log('Trace saved to:', tracePath);

// Read data
const data = await traceRecord.readData(tracePath);
console.log('Trace data:', data);

// Cleanup
await traceRecord.destroy();
```

### CLI

```bash
# Show help
trace-record --help

# Start trace recording
trace-record start --output-dir ./traces --name my_trace

# Write data to recording
trace-record write-data --data '[{"event":"click","timestamp":1234567890}]'

# End trace recording
trace-record end --output-dir ./traces

# Read trace data from file
trace-record read-data --path ./traces/my_trace.json
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start` | Start trace recording |
| `end` | End trace recording |
| `read-data` | Read trace data from file |
| `write-data` | Write data to current trace recording |

## License

Apache License Version 2.0
