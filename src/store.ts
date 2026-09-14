import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ensureHome } from './files.js';
import { HELD_STATES, type Activity, type Run, type Sprint } from './model.js';

/** Runtime receipts and slot ownership. Work-item state belongs to the invoked skill. */
export class Store {
  readonly db: DatabaseSync;
  constructor(home: string) {
    ensureHome(home);
    this.db = new DatabaseSync(join(home, 'runtime.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));`);
  }
  close(): void { this.db.close(); }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  all<T>(kind: string): T[] {
    return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(String(row.body)) as T);
  }
  put(kind: string, id: string, body: unknown): void {
    this.db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, id, JSON.stringify(body));
  }
  delete(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  runs(): Run[] { return this.all<Run>('run'); }
  held(): Run[] { return this.runs().filter(run => HELD_STATES.includes(run.state)); }
  run(id: string): Run {
    const run = this.get<Run>('run', id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return run;
  }
  updateRun(id: string, changes: Partial<Run>, now = Date.now()): Run {
    return this.transaction(() => {
      const run = { ...this.run(id), ...changes, updatedAt: now };
      this.put('run', id, run); return run;
    });
  }
  sprints(): Sprint[] { return this.all<Sprint>('sprint'); }
  activities(): Activity[] { return this.all<Activity>('activity'); }
}
