import DatabaseConstructor, { Database as SQLiteDatabase } from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class Database {
  private db: SQLiteDatabase;

  constructor(dbPath: string) {
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
  }

  public getDb(): SQLiteDatabase {
    return this.db;
  }

  public close(): void {
    this.db.close();
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const migrationsDir = join(__dirname, 'migrations');
    let files: string[];
    try {
      files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    } catch (err) {
      throw new Error(
        `Migrations directory not found at "${migrationsDir}". ` +
          `The .sql migration files must be bundled alongside the compiled output ` +
          `(the build step copies them into dist/db/migrations). ` +
          `Original error: ${(err as Error).message}`
      );
    }

    if (files.length === 0) {
      throw new Error(`No .sql migration files found in "${migrationsDir}".`);
    }

    const appliedResult = this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    const appliedVersions = new Set(appliedResult.map(r => r.version));

    const transaction = this.db.transaction(() => {
      for (const file of files) {
        const versionMatch = file.match(/^(\d+)_/);
        if (!versionMatch) continue;
        
        const version = parseInt(versionMatch[1], 10);
        if (appliedVersions.has(version)) continue;

        const sql = readFileSync(join(migrationsDir, file), 'utf-8');
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
      }
    });

    transaction();
  }
}
