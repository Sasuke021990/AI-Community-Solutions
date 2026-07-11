// Copies non-.ts runtime assets into the compiled output, since tsc does
// not copy them: SQL migration files and the role-template catalog.
import { cpSync, existsSync, readdirSync, copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

function copyMigrations() {
  const src = join(here, '..', 'src', 'db', 'migrations');
  const dest = join(here, '..', 'dist', 'db', 'migrations');
  if (!existsSync(src)) {
    console.error(`[copy-assets] migrations source not found: ${src}`);
    process.exit(1);
  }
  cpSync(src, dest, { recursive: true });
  const copied = readdirSync(dest).filter((f) => f.endsWith('.sql'));
  if (copied.length === 0) {
    console.error(`[copy-assets] no .sql files copied to ${dest}`);
    process.exit(1);
  }
  console.log(`[copy-assets] copied ${copied.length} migration file(s) into dist/db/migrations`);
}

function copyRoleTemplates() {
  const src = join(here, '..', 'src', 'templates', 'roles.json');
  const destDir = join(here, '..', 'dist', 'templates');
  const dest = join(destDir, 'roles.json');
  if (!existsSync(src)) {
    console.error(`[copy-assets] role templates source not found: ${src}`);
    process.exit(1);
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log('[copy-assets] copied roles.json into dist/templates');
}

function copyPresets() {
  const src = join(here, '..', 'src', 'presets', 'presets.json');
  const destDir = join(here, '..', 'dist', 'presets');
  const dest = join(destDir, 'presets.json');
  if (!existsSync(src)) {
    console.error(`[copy-assets] presets source not found: ${src}`);
    process.exit(1);
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log('[copy-assets] copied presets.json into dist/presets');
}

copyMigrations();
copyRoleTemplates();
copyPresets();
