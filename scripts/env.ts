// Minimal .env loader (no dependency): KEY=VALUE lines, # comments; real env vars win.
import fs from 'node:fs';
import path from 'node:path';
export function loadEnv(file = path.resolve(import.meta.dirname, '../.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
