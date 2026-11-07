import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: {
    duration: number;
    changes: number;
    last_row_id: number;
    changed_db: boolean;
    size_after: number;
    rows_read: number;
    rows_written: number;
  };
}

function input(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return new Uint8Array(value);
  throw new TypeError('D1_TYPE_ERROR: Unsupported bind type ' + typeof value);
}

function output(value: SQLOutputValue): unknown {
  return value instanceof Uint8Array ? Array.from(value) : value;
}

export class D1Statement {
  readonly database: D1Adapter;
  readonly query: string;
  readonly values: SQLInputValue[];
  constructor(database: D1Adapter, query: string, values: SQLInputValue[] = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }
  bind(...values: unknown[]): D1Statement { return new D1Statement(this.database, this.query, values.map(input)); }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database.sqlite.prepare(this.query).get(...this.values);
    if (!row) return null;
    if (column !== undefined) {
      if (!(column in row)) throw new Error('D1_COLUMN_NOTFOUND: Column ' + column + ' not found');
      return output(row[column]) as T;
    }
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, output(value)])) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async raw<T = unknown[]>(options: { columnNames?: boolean } = {}): Promise<T[]> {
    const stmt = this.database.sqlite.prepare(this.query);
    stmt.setReturnArrays(true);
    const rows = (stmt.all(...this.values) as unknown as SQLOutputValue[][]).map(row => row.map(output));
    if (options.columnNames) rows.unshift(stmt.columns().map(column => column.name));
    return rows as T[];
  }
  // Synchronous execution prevents interleaving while a batch transaction is open.
  execute<T>(): D1Result<T> {
    const db = this.database.sqlite;
    const started = performance.now();
    const before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
    const schemaBefore = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
    const results = db.prepare(this.query).all(...this.values).map(row =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, output(value)]))
    ) as T[];
    const after = db.prepare('SELECT total_changes() AS n, changes() AS changes, last_insert_rowid() AS id').get()!;
    const changed = Number(after.n) !== before;
    return {
      results,
      success: true,
      meta: {
        duration: performance.now() - started,
        // changes() is sticky; reads must not inherit the previous write's count.
        changes: changed ? Number(after.changes) : 0,
        last_row_id: Number(after.id),
        changed_db: changed || Number(db.prepare('PRAGMA schema_version').get()!.schema_version) !== schemaBefore,
        size_after: this.database.size(),
        rows_read: results.length,
        rows_written: Number(after.n) - before,
      },
    };
  }
}

export class D1Adapter {
  readonly sqlite: DatabaseSync;
  constructor(sqlite: DatabaseSync) { this.sqlite = sqlite; }
  prepare(query: string): D1Statement { return new D1Statement(this, query); }
  async batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]> {
    if (!statements.length) return [];
    if (statements.some(stmt => stmt.database !== this)) throw new Error('D1 batch: foreign statement');
    this.sqlite.exec('SAVEPOINT pahub_d1_batch');
    try {
      const results = statements.map(stmt => stmt.execute<T>());
      this.sqlite.exec('RELEASE pahub_d1_batch');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK TO pahub_d1_batch; RELEASE pahub_d1_batch');
      throw error;
    }
  }
  async exec(query: string): Promise<{ count: number; duration: number }> {
    const start = performance.now();
    this.sqlite.exec(query);
    return { count: countStatements(query), duration: performance.now() - start };
  }
  size(): number {
    return Number(this.sqlite.prepare('PRAGMA page_count').get()!.page_count)
      * Number(this.sqlite.prepare('PRAGMA page_size').get()!.page_size);
  }
}

export function countStatements(sql: string): number {
  // Tokenize only SQL syntax; quoted strings/identifiers and comments cannot terminate a statement.
  const tokens = sql.match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_]+|;|[^\s]/g) || [];
  let count = 0;
  let hasContent = false;
  let trigger = false;
  let blocks = 0;
  let previous = '';
  for (const token of tokens) {
    if (token.startsWith('--') || token.startsWith('/*')) continue;
    const keyword = token.toUpperCase();
    if (token === ';') {
      if (!trigger || blocks === 0) {
        if (hasContent) count++;
        hasContent = false; trigger = false; previous = '';
      }
      continue;
    }
    hasContent = true;
    if (keyword === 'TRIGGER' && (previous === 'CREATE' || previous === 'TEMP' || previous === 'TEMPORARY')) trigger = true;
    if (trigger && (keyword === 'BEGIN' || keyword === 'CASE')) blocks++;
    if (trigger && keyword === 'END') blocks--;
    previous = keyword;
  }
  return count + (hasContent ? 1 : 0);
}
