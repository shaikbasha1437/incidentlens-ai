const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'); const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const js = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
test('every script parses', () => { for (const f of js.concat(['sw.js'])) execFileSync(process.execPath, ['--check', path.join(ROOT, f.endsWith('sw.js') && f === 'sw.js' ? f : 'js/' + f)]); });
test('the page loads every module except the worker, and the service worker caches all of them', () => {
  const html = read('index.html'); const sw = read('sw.js');
  for (const f of js) { if (f !== 'worker.js') assert.ok(html.includes('src="js/' + f + '"'), 'index.html loads ' + f); assert.ok(sw.includes("'./js/" + f + "'"), 'sw.js caches ' + f); }
  assert.match(sw, /const VERSION = 'incidentlens-v\d+'/); assert.match(html, /THE INCIDENT AGENT/);
});
test('the worker imports the modules it needs', () => { const w = read('js/worker.js'); for (const m of ['text', 'redact', 'parse', 'guard', 'cluster', 'pipeline']) assert.ok(w.includes("'" + m + ".js'"), m); });
test('the manifest is valid and its icons exist', () => { const m = JSON.parse(read('manifest.webmanifest')); for (const i of m.icons) assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src); });
