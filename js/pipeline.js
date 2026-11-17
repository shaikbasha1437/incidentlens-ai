/* IncidentLens ingest pipeline: redact -> parse -> flag injection -> cluster -> per-minute counts -> keep.
   The same code runs in the page, in the Web Worker for big files, and in Node tests. Redaction happens on each
   raw line first, so nothing unredacted is ever kept. Very large inputs keep every warning and error line and a
   thinning sample of the rest; cluster and per-minute counts still cover every line. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./redact.js'), require('./parse.js'), require('./guard.js'), require('./cluster.js'));
  else (root.IL = root.IL || {}).pipeline = factory(root.IL.redact, root.IL.parse, root.IL.guard, root.IL.cluster);
})(typeof self !== 'undefined' ? self : this, function (R, P, G, C) {
  'use strict';
  const MAX_KEEP = 60000; const MAX_HITS = 400;
  function createPipeline(opts) {
    const o = Object.assign({ ip: false, maxKeep: MAX_KEEP }, opts || {});
    const entries = []; const drain = C.createDrain(); const minutes = new Map(); const hits = []; const hitCount = {}; const flagged = [];
    const stats = { lines: 0, entries: 0, kept: 0, dropped: 0, formats: {}, sources: [], services: {}, levels: {}, first: null, last: null, noTs: 0 };
    let id = 0; let infoKept = 0; let stride = 1; let infoSeen = 0;
    function take(e, src) {
      id++; e.id = id; stats.entries++;
      if (e.ts == null && src.lastTs != null) { e.ts = src.lastTs; e.tsInherited = true; } else if (e.ts != null) src.lastTs = e.ts; else stats.noTs++;
      e.cmsg = C.clusterMsg(e);
      const scanText = e.raw + (e.http && e.http.ua && e.raw.indexOf(e.http.ua) < 0 ? ' ' + e.http.ua : '');
      const rules = G.rules(scanText); if (rules.length) { e.flag = rules; flagged.push(e.id); }
      e.c = drain.add(e); delete e.cmsg;
      stats.formats[e.fmt] = (stats.formats[e.fmt] || 0) + 1; src.entries++; src.fmts[e.fmt] = (src.fmts[e.fmt] || 0) + 1;
      if (e.service) stats.services[e.service] = (stats.services[e.service] || 0) + 1;
      stats.levels[e.level] = (stats.levels[e.level] || 0) + 1;
      if (e.ts != null) {
        if (stats.first == null || e.ts < stats.first) stats.first = e.ts; if (stats.last == null || e.ts > stats.last) stats.last = e.ts;
        const k = Math.floor(e.ts / 60000) * 60000; let b = minutes.get(k); if (!b) { b = { t: k, n: 0, warn: 0, error: 0, s5xx: 0, s4xx: 0, req: 0, latSum: 0, latN: 0, lats: [] }; minutes.set(k, b); }
        b.n++; if (e.level === 'warn') b.warn++; if (e.level === 'error' || e.level === 'fatal') b.error++;
        if (e.http) { b.req++; if (e.http.status >= 500) b.s5xx++; else if (e.http.status >= 400) b.s4xx++; if (e.http.ms != null && isFinite(e.http.ms)) { b.latSum += e.http.ms; b.latN++; if (b.lats.length < 200) b.lats.push(e.http.ms); } }
      }
      const important = P.RANK[e.level] >= 3 || e.flag || e.k8s || e.trace;
      let keep = true;
      if (entries.length >= o.maxKeep) keep = false;
      else if (!important) { infoSeen++; if (infoKept >= o.maxKeep * 0.5) { if (infoSeen % stride !== 0) keep = false; } if (keep) { infoKept++; if (infoKept >= o.maxKeep * 0.5 && infoKept % Math.max(1, Math.floor(o.maxKeep * 0.1)) === 0) stride *= 2; } }
      if (keep) { entries.push(e); stats.kept++; } else stats.dropped++;
    }
    function addSource(name, sopts) {
      const src = { name: name || 'pasted logs', lines: 0, entries: 0, fmts: {}, lastTs: null }; stats.sources.push(src);
      const service = (sopts && sopts.service) || guessService(name);
      const parser = P.createParser({ year: o.year, now: o.now, service, source: src.name, preprocess: (line, n) => { const r = R.line(line, { ip: o.ip }); for (const h of r.hits) { hitCount[h.type] = (hitCount[h.type] || 0) + 1; if (hits.length < MAX_HITS) hits.push({ source: src.name, n, type: h.type, hint: h.hint }); } return r; } }, (e) => take(e, src));
      let jsonBuf = null; let firstChunk = true;
      return {
        push(chunk) { if (firstChunk) { firstChunk = false; const t = chunk.trimStart(); if (t[0] === '[' || /^\{\s*"(events|items|logs|data|results|logEvents)"\s*:/.test(t)) jsonBuf = ''; } if (jsonBuf != null) { jsonBuf += chunk; return; } parser.push(chunk); },
        end() { if (jsonBuf != null) { const ex = P.expandJsonDoc(jsonBuf); parser.push(ex != null ? ex : jsonBuf); jsonBuf = null; } const r = parser.end(); src.lines = r.lines; stats.lines += r.lines; src.fmt = Object.entries(src.fmts).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || 'empty'; return src; }
      };
    }
    function finish() {
      const sources = stats.sources.map((s) => ({ name: s.name, lines: s.lines, entries: s.entries, fmt: s.fmt || 'empty', fmts: s.fmts }));
      return { entries, clusters: drain.result(), minutes: Array.from(minutes.values()).sort((a, b) => a.t - b.t), stats: Object.assign({}, stats, { sources }), redactions: { summary: R.summary(Object.entries(hitCount).flatMap(([type, n]) => Array(n).fill({ type }))), hits, total: Object.values(hitCount).reduce((a, b) => a + b, 0) }, flagged, ipRedacted: !!o.ip };
    }
    return { addSource, finish };
  }
  function guessService(name) { const b = String(name || '').split(/[\\/]/).pop().replace(/\.(log|txt|json|jsonl|ndjson|csv|out|err|gz)$/gi, '').replace(/[-_.]?(access|error|events|syslog|stdout|stderr|export|logs?|\d{4}-\d{2}-\d{2})$/i, '').replace(/[-_.]?(access|error)$/i, ''); return /^[a-z][\w-]{1,40}$/i.test(b) && !/^(pasted|logs?|output|export|messages|kubectl|describe|untitled|datadog|cloudwatch)$/i.test(b) ? b : null; }
  /* Convenience for tests and small pastes: sources = [{ name, text }]. */
  function run(sources, opts) { const p = createPipeline(opts); for (const s of sources) { const a = p.addSource(s.name, s); a.push(String(s.text || '')); a.end(); } return p.finish(); }
  return { createPipeline, run, guessService, MAX_KEEP };
});
