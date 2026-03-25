// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { util } from 'protobufjs';

// Values of these constants correspond to the QueryResponse message at
// protos/perfetto/trace_processor/trace_processor.proto
const QUERY_CELL_NULL_FIELD_ID = 1;
const QUERY_CELL_VARINT_FIELD_ID = 2;
const QUERY_CELL_TYPE_COUNT = 6;

/**
 * Extract strings from string_cells field, handling both string and bytes input.
 * Corresponds to Python's _extract_strings function.
 */
function extractStrings(x: string | Uint8Array): string[] {
  let input: string;
  if (x instanceof Uint8Array) {
    // Decode bytes to string, ignoring invalid UTF-8 characters
    const decoder = new TextDecoder('utf-8', { fatal: false });
    input = decoder.decode(x);
  } else {
    input = x;
  }
  const res = input.split('\0');
  if (res.length > 0) {
    res.pop(); // Remove last empty element
  }
  return res;
}

/**
 * Exception class for Perfetto-related errors.
 */
export class PerfettoException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerfettoException';
  }
}

/**
 * Represents a single row in the query result.
 * Each column name is stored as a property of this class.
 * Corresponds to Python's QueryResultIterator.Row class.
 */
export class Row {
  [key: string]: any;

  toString(): string {
    return JSON.stringify(this);
  }

  valueOf(): Record<string, any> {
    return { ...this };
  }
}

/**
 * Iterator for query results from trace processor.
 * Provides a TypeScript interface to operate on the contents of QueryResult protos.
 * Corresponds to Python's QueryResultIterator class.
 */
export class QueryResultIterator implements Iterable<Row> {
  private columnNames: string[];
  private columnCount: number;
  private cellCount: number;
  private rowCount: number;
  private cells: any[];

  constructor(columnNames: string[], batches: any[]) {
    this.columnNames = [...columnNames]; // Copy array
    this.columnCount = columnNames.length;

    // Check if last batch has is_last_batch flag set
    if (batches.length > 0 && !batches[batches.length - 1].isLastBatch) {
      throw new PerfettoException('Last batch did not have is_last_batch flag set');
    }

    // Calculate total cell count
    this.cellCount = batches.reduce((total, batch) => {
      return total + (batch.cells ? batch.cells.length : 0);
    }, 0);

    // Validate cell count is divisible by column count
    for (const batch of batches) {
      if (this.columnCount > 0 && batch.cells && batch.cells.length % this.columnCount !== 0) {
        throw new PerfettoException(`Result has ${this.cellCount} cells, not divisible by ${this.columnCount} columns`);
      }
    }

    this.rowCount = this.columnCount > 0 ? Math.floor(this.cellCount / this.columnCount) : 0;
    this.cells = new Array(this.cellCount);
    this.preprocessCells(batches);
  }

  private preprocessCells(batches: any[]) {
    // Collect all data arrays from batches, similar to Python implementation
    const varintCells: any[] = [];
    const float64Cells: any[] = [];
    const stringCells: string[] = [];
    const blobCells: any[] = [];
    const allCellTypes: number[] = [];

    // Flatten all cell types and data arrays from batches
    for (const batch of batches) {
      if (batch.cells) {
        allCellTypes.push(...batch.cells);
      }
      if (batch.varintCells) {
        varintCells.push(...batch.varintCells);
      }
      if (batch.float64Cells) {
        float64Cells.push(...batch.float64Cells);
      }
      if (batch.stringCells) {
        const strings = extractStrings(batch.stringCells);
        stringCells.push(...strings);
      }
      if (batch.blobCells) {
        blobCells.push(...batch.blobCells);
      }
    }

    // Create cells array similar to Python's non-numpy implementation
    const cells = [
      [], // QUERY_CELL_INVALID_FIELD_ID
      [], // QUERY_CELL_NULL_FIELD_ID
      varintCells, // QUERY_CELL_VARINT_FIELD_ID
      float64Cells, // QUERY_CELL_FLOAT64_FIELD_ID
      stringCells, // QUERY_CELL_STRING_FIELD_ID
      blobCells, // QUERY_CELL_BLOB_FIELD_ID
    ];

    const cellOffsets = new Array(QUERY_CELL_TYPE_COUNT).fill(0);

    // Fill cells array based on cell types
    for (let i = 0; i < allCellTypes.length; i++) {
      const cellType = allCellTypes[i];
      if (cellType === QUERY_CELL_NULL_FIELD_ID) {
        this.cells[i] = null;
      } else if (cellType! >= 0 && cellType! < cells.length && cells[cellType!]) {
        const typeArray = cells[cellType!];
        if (cellOffsets[cellType!] < typeArray!.length) {
          let value = typeArray![cellOffsets[cellType!]];
          // Handle Long objects (from protobuf) for varint cells
          if (cellType === QUERY_CELL_VARINT_FIELD_ID && typeof value === 'object' && value.low !== undefined) {
            // Cast to unsigned 32-bit integers before bit operations
            const low = value.low >>> 0;
            const high = value.high >>> 0;
            // Use LongBits toNumber() method which correctly handles both signed and unsigned integers
            // If value.unsigned is true, treat as unsigned integer (use toNumber(true))
            // If value.unsigned is false or undefined, treat as signed integer (use toNumber())
            const isUnsigned = value.unsigned === true;
            value = new util.LongBits(low, high).toNumber(isUnsigned);
          }
          this.cells[i] = value;
        } else {
          this.cells[i] = null;
        }
      } else {
        this.cells[i] = null;
      }
      if (cellType !== QUERY_CELL_NULL_FIELD_ID) {
        cellOffsets[cellType!]++;
      }
    }
  }

  /**
   * Get the number of rows in the result set.
   * Corresponds to Python's __len__ method.
   */
  get length(): number {
    return this.rowCount;
  }

  /**
   * Convert the result to a simple array of objects.
   * Similar to Python's as_pandas_dataframe() but returns plain objects.
   */
  toArray(): Row[] {
    const results: Row[] = [];
    for (const row of this) {
      results.push(row);
    }
    return results;
  }

  /**
   * Iterator implementation.
   * Corresponds to Python's __iter__ and __next__ methods.
   */
  [Symbol.iterator](): Iterator<Row> {
    let currentCellIndex = 0;
    const totalCells = this.cellCount;
    const columnCount = this.columnCount;
    const columnNames = this.columnNames;
    const cells = this.cells;

    return {
      next(): IteratorResult<Row> {
        if (currentCellIndex >= totalCells) {
          return { done: true, value: undefined };
        }

        const result = new Row();
        for (let i = 0; i < columnNames.length; i++) {
          const columnName = columnNames[i];
          result[columnName!] = cells[currentCellIndex + i];
        }

        currentCellIndex += columnCount;
        return { done: false, value: result };
      },
    };
  }
}
