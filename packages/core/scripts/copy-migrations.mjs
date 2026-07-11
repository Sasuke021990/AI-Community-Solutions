// Copies SQL migration files into the compiled output so the built package
// can find them at runtime (tsc does not copy non-.ts assets).
import { cpSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'db', 'migrations');
const dest = join(here, '..', 'dist', 'db', 'migrations');

if (!existsSync(src)) {
  console.error(`[copy-migrations] source directory not found: ${src}`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });

const copied = readdirSync(dest).filter((f) => f.endsWith('.sql'));
if (copied.length === 0) {
  console.error(`[copy-migrations] no .sql files copied to ${dest}`);
  process.exit(1);
}

console.log(`[copy-migrations] copied ${copied.length} migration file(s) into dist/db/migrations`);
