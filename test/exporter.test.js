const test = require('node:test'); const assert = require('node:assert');
const X = require('../js/exporter.js'); const PT = require('../js/patterns.js'); const S = require('../js/seed.js'); const { all } = require('./helpers.js');
const built = all(); const b = built[0];
test('status drafts exist for Slack, the status page and stakeholders, and mention the hypothesis', () => {
  const d = X.statusDrafts(b.inc, b.res, b.an, S.COMPANY); assert.deepStrictEqual(Object.keys(d).sort(), ['slack', 'stakeholders', 'statuspage']);
  assert.match(d.slack.body, /Bad deploy/); for (const k of Object.keys(d)) assert.ok(d[k].body.length > 40);
  assert.doesNotMatch(d.statuspage.body, /checkout-api|v2\.41|TypeError/, 'the public status page has no internal detail');
});
test('the postmortem has the blameless sections and passes its own blame lint', () => {
  for (const x of built) { const md = X.postmortemMd(X.postmortem(x.inc, x.res, x.an)); for (const h of ['Summary', 'Impact', 'Timeline', 'Root cause', 'Action items']) assert.match(md, new RegExp('## ' + h), x.seed.id + ' ' + h); assert.deepStrictEqual(X.blameLint(md), [], x.seed.id); }
});
test('blame lint catches blaming language', () => { assert.ok(X.blameLint('Root cause: Priya was careless and should have tested').length >= 1); assert.strictEqual(X.blameLint('The deploy pipeline had no canary step.').length, 0); });
test('the abstaining incident says so in the postmortem and report', () => { const x = built.find((y) => y.seed.id === 'INC-2046'); assert.match(X.reportMd(x.inc, x.res, x.an), /No root cause named/); assert.match(X.postmortemMd(X.postmortem(x.inc, x.res, x.an)), /not yet determined/i); });
test('clusters CSV has a header and one row per cluster, with cells escaped', () => {
  const csv = X.clustersCsv(b.res, b.an); const rows = csv.trim().split('\n'); assert.match(rows[0], /^cluster,count,level,template/); assert.ok(rows.length >= b.res.clusters.length + 1);
  assert.strictEqual(X.csvCell('a,"b"'), '"a,""b"""'); assert.strictEqual(X.csvCell('=cmd()'), '"\'=cmd()"', 'formula injection is neutralised');
});
test('the report cites lines and never includes injected text', () => { const md = X.reportMd(b.inc, b.res, b.an); assert.match(md, /L\d+/); assert.doesNotMatch(md, /ignore previous instructions/i); });
test('backups never include settings or keys and round-trip', () => {
  const state = { version: 1, incidents: [b.inc].map((i) => Object.assign({}, i, { res: b.res })), patterns: PT.PATTERNS, past: PT.PAST, settings: { key: 'x' }, keys: { openai: 'test-key-not-real-123456' } };
  const json = X.backupJson(state); assert.ok(!json.includes('test-key-not-real-123456')); assert.ok(!/"settings"|"keys"/.test(json));
  const back = X.parseBackup(json); assert.strictEqual(back.incidents.length, 1); assert.throws(() => X.parseBackup('{"app":"other"}'), /not an IncidentLens/); assert.throws(() => X.parseBackup('nope'), /not JSON/);
});
test('built-in patterns validate and a pattern with only symptoms is refused', () => {
  for (const p of PT.PATTERNS) assert.deepStrictEqual(PT.validate(p), [], p.id);
  assert.ok(PT.validate({ title: 'x', signals: [{ label: 's', re: 'timeout', role: 'symptom' }] }).some((e) => /cause/.test(e)));
  assert.ok(PT.validate({ title: 'x', signals: [{ label: 's', re: '.*', role: 'cause' }] }).some((e) => /every line/.test(e)));
  assert.ok(PT.validate({ title: 'x', signals: [{ label: 's', re: '(', role: 'cause' }] }).some((e) => /not a valid/.test(e)));
});
