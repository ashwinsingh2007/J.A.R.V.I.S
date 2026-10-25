// Syntax check for every JavaScript file, so CI catches typos without
// starting Electron. Usage: npm run check
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PYTHON } from './python.mjs';

const files = [];
const walk = (d) => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) walk(p);
  else if (/\.(m?js)$/.test(f) && !f.endsWith('.min.js')) files.push(p);
});
['src', 'test'].forEach(walk);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(r.stderr); }
}
const py = spawnSync(PYTHON, ['-m', 'py_compile', 'scripts/memory.py', 'scripts/remind.py', 'scripts/kokoro_server.py'], { encoding: 'utf8' });
if (py.status !== 0) { bad++; console.error(py.stderr); }
console.log(`${files.length} JavaScript files and 3 Python scripts checked, ${bad} with errors`);
process.exit(bad ? 1 : 0);
