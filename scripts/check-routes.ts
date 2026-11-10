// §19.4 "Every route declares a permission (static check)".
// Each exported HTTP handler in apps/web/app/api/**/route.ts must be built with route(P.X, …), actions({...}) where every
// entry has `perm: P.X`, or an explicitly justified publicRoute('reason', …) / sessionRoute('reason', …).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../apps/web/app/api');
const files: string[] = [];
const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'route.ts') files.push(p); } };
walk(root);

const problems: string[] = [];
const summary: string[] = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  const exports = [...src.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b\s*(=\s*([a-zA-Z]+)\(\s*('[^']*'|[^,)\n]*))?/g)];
  if (!exports.length) problems.push(`${rel}: no HTTP handler exported`);
  for (const m of exports) {
    const [, method, , builder, firstArg] = m;
    if (builder === 'route' && /^P\.[A-Z_]+$/.test(firstArg.trim())) summary.push(`${method} ${rel}  ${firstArg.trim()}`);
    else if ((builder === 'publicRoute' || builder === 'sessionRoute') && /^'[^']{8,}'$/.test(firstArg.trim())) summary.push(`${method} ${rel}  [${builder}] ${firstArg.trim()}`);
    else if (builder === 'actions') {
      const block = src.slice(src.indexOf('actions({'));
      const entries = [...block.matchAll(/^\s*'?([\w-]+)'?\s*:\s*\{(.*)$/gm)];
      if (!entries.length) problems.push(`${rel}: empty action table`);
      for (const e of entries) {
        const perm = /perm:\s*(P\.[A-Z_]+)/.exec(e[2]);
        if (!perm) problems.push(`${rel}: action '${e[1]}' has no perm: P.X`);
        else summary.push(`${method} ${rel} :${e[1]}  ${perm[1]}`);
      }
    } else problems.push(`${rel}: ${method} is not wrapped in route(P.X, …), actions(…), publicRoute('reason') or sessionRoute('reason')`);
  }
}
if (process.argv.includes('--list')) console.log(summary.join('\n'));
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`route check: ${files.length} route files, ${summary.length} handlers/actions, all declare a permission or a public/session reason`);
