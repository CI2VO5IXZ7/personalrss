import { DatabaseSync } from 'node:sqlite';

export class D1Mock {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.batchTail = Promise.resolve();
  }

  exec(sql) {
    this.db.exec(sql);
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return new D1PreparedStatementMock(stmt, [], sql);
  }

  async batch(statements) {
    const previousBatch = this.batchTail;
    let releaseBatch;
    this.batchTail = new Promise(resolve => {
      releaseBatch = resolve;
    });
    await previousBatch;

    try {
      this.db.exec('BEGIN');
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      releaseBatch();
    }
  }
}

class D1PreparedStatementMock {
  constructor(stmt, bindings = [], sql = '') {
    this.stmt = stmt;
    this.bindings = bindings;
    this.sql = sql;
  }

  bind(...args) {
    // D1 bind can accept arguments that are Date or Boolean or Object.
    // SQLite bindings must be strings, numbers, null, or buffers.
    // Let's normalize bindings: convert objects/arrays to JSON string, booleans to 1/0, Dates to ISO string.
    const normalized = args.map(arg => {
      if (arg instanceof Date) return arg.toISOString();
      if (typeof arg === 'boolean') return arg ? 1 : 0;
      if (arg !== null && typeof arg === 'object') return JSON.stringify(arg);
      return arg;
    });
    return new D1PreparedStatementMock(this.stmt, normalized, this.sql);
  }

  async run() {
    try {
      const upperSql = (this.sql || '').toUpperCase();
      if (upperSql.includes('RETURNING') || upperSql.trimStart().startsWith('SELECT')) {
        const results = this.stmt.all(...this.bindings);
        return {
          success: true,
          results,
          meta: {
            changes: results.length
          }
        };
      }
      const result = this.stmt.run(...this.bindings);
      return {
        success: true,
        meta: {
          changes: result.changes,
          last_row_id: result.lastInsertRowid
        }
      };
    } catch (e) {
      if (e.message && (e.message.includes('returning values') || e.message.includes('results'))) {
        const results = this.stmt.all(...this.bindings);
        return {
          success: true,
          results,
          meta: {
            changes: results.length
          }
        };
      }
      throw e;
    }
  }

  async all() {
    const results = this.stmt.all(...this.bindings);
    return {
      success: true,
      results
    };
  }

  async first(colName) {
    const row = this.stmt.get(...this.bindings);
    if (!row) return null;
    if (colName) {
      return row[colName] !== undefined ? row[colName] : null;
    }
    return row;
  }
}
