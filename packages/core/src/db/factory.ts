import { Database } from './Database.js';
import {
  McpServerRepo,
  SpaceRepo,
  AgentRepo,
  RunRepo,
  RunEventRepo
} from './repos/index.js';

export interface Repositories {
  db: Database;
  mcpServers: McpServerRepo;
  spaces: SpaceRepo;
  agents: AgentRepo;
  runs: RunRepo;
  runEvents: RunEventRepo;
}

/** Opens (and migrates) the SQLite database at the given path. */
export function openDatabase(dbPath: string): Database {
  return new Database(dbPath);
}

/** Builds the full set of repositories over an open database. */
export function createRepositories(db: Database): Repositories {
  const sqlite = db.getDb();
  return {
    db,
    mcpServers: new McpServerRepo(sqlite),
    spaces: new SpaceRepo(sqlite),
    agents: new AgentRepo(sqlite),
    runs: new RunRepo(sqlite),
    runEvents: new RunEventRepo(sqlite)
  };
}
