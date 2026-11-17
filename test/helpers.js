/* Shared test helpers: build each demo incident the way the app does. */
const S = require('../js/seed.js'); const PL = require('../js/pipeline.js'); const D = require('../js/detect.js'); const A = require('../js/analyze.js');
function build(s, opts) {
  const res = PL.run(s.sources, Object.assign({ year: 2026 }, opts || {}));
  const changes = s.changes ? D.parseChanges(s.changes.text, { year: 2026 }).changes : [];
  const metrics = s.metrics ? D.parseMetrics(s.metrics.text, { year: 2026 }) : { series: [], errors: [] };
  const inc = { id: s.id, title: s.title, sev: s.sev, status: s.status, owner: s.owner, commander: s.commander, opened: s.opened, ns: s.ns, services: s.services, changes, metrics, notes: [], drafts: {}, truth: s.truth };
  const an = A.analyze(res, { changes, metrics, context: { ns: s.ns } });
  return { seed: s, res, inc, an };
}
const all = () => S.incidents().map((s) => build(s));
module.exports = { build, all, S };
