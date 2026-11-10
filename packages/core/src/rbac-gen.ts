// Generates the §10.1 SQL seed and the §8.4 matrix from the single catalog (rbac.ts).
// `pnpm gen:rbac` rewrites packages/db/migrations/0011_seed_rbac.sql only if it is not yet applied anywhere;
// the test suite (rbac-generated.test.ts) fails if either generated copy drifts from the catalog.
import { PERMISSIONS } from './rbac';
import { PERMISSION_LABELS } from './rbac-labels';
import { ROLES } from './roles';

const MARK = { normal: '', sensitive: ' †', pin_stepup: ' ‡' } as const;

export function generateSeedSql(): string {
  const roleRows: string[] = [];
  for (let i = 0; i < ROLES.length; i += 1) {
    const r = ROLES[i];
    roleRows.push(`('${r.code}','${r.name}',${r.requiresMfa},true)`);
  }
  // Same line grouping as the spec: pairs on the first lines, then threes.
  const grouped = [
    roleRows.slice(0, 2), roleRows.slice(2, 4), roleRows.slice(4, 6), roleRows.slice(6, 8),
    roleRows.slice(8, 11), roleRows.slice(11, 13), roleRows.slice(13, 16), roleRows.slice(16, 18),
  ].map((g) => '  ' + g.join(', '));
  const lines: string[] = [];
  lines.push('INSERT INTO roles (code, name, requires_mfa, is_system) VALUES');
  lines.push(grouped.join(',\n') + ';');
  lines.push('');
  lines.push("ALTER TABLE permissions ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'normal'");
  lines.push("  CHECK (sensitivity IN ('normal','sensitive','pin_stepup'));");
  lines.push('INSERT INTO permissions (code, description, sensitivity) VALUES');
  lines.push(PERMISSIONS.map((p) => `  ('${p.code}','${PERMISSION_LABELS[p.code]}','${p.sensitivity}')`).join(',\n') + ';');
  lines.push('INSERT INTO role_permissions (role_id, permission_code)');
  lines.push('SELECT r.id, v.p FROM (VALUES');
  const pairs: string[] = [];
  for (const p of PERMISSIONS) for (const r of p.roles) pairs.push(`  ('${r}','${p.code}')`);
  lines.push(pairs.join(',\n'));
  lines.push(') AS v(role, p) JOIN roles r ON r.code = v.role;');
  return lines.join('\n') + '\n';
}

export function generateMatrixMarkdown(): string {
  const head = `| Permission | Code | ${ROLES.map((r) => r.abbr).join(' | ')} |`;
  const sep = `|---|---|${ROLES.map(() => '---').join('|')}|`;
  const rows = PERMISSIONS.map((p) => {
    const held = new Set<string>(p.roles);
    const cells = ROLES.map((r) => (held.has(r.code) ? '✔' : '')).join(' | ');
    return `| ${PERMISSION_LABELS[p.code]}${MARK[p.sensitivity]} | \`${p.code}\` | ${cells} |`;
  });
  return [head, sep, ...rows].join('\n') + '\n';
}

if (process.argv.includes('--write')) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const target = path.resolve(here, '../../db/migrations/0011_seed_rbac.sql');
  const header = fs.readFileSync(target, 'utf8').split('\n')[0];
  fs.writeFileSync(target, header + '\n' + generateSeedSql());
  process.stdout.write(`wrote ${target}\n--- §8.4 matrix ---\n${generateMatrixMarkdown()}`);
}
