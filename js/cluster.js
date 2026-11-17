/* IncidentLens clustering: a small Drain-style log template miner. Variable parts (numbers, IDs, hashes, IPs,
   durations, quoted values) are masked, lines are grouped by length and leading words, and a line joins the most
   similar template in its group (or starts a new one). Differing positions become <*>. Works incrementally, so
   counts stay exact even when a huge file is sampled for storage. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.IL = root.IL || {}).cluster = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MASKS = [
    [/\[REDACTED:[\w-]+\]/g, '<SECRET>'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
    [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
    [/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[a-z0-9]{8,10}-[a-z0-9]{5}\b/g, '<POD>'],
    [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<IP>'],
    [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<HEX>'],
    [/\b0x[0-9a-f]+\b/gi, '<HEX>'],
    [/(\/[\w.-]*?)\d+(?=[/?\s]|$)/g, '$1<N>'],
    [/\b\d+(?:\.\d+)?(?:ms|s|m|h|us|ns|mb|gb|kb|b|%|mi|gi)?\b/gi, '<NUM>'],
    [/'[^']{1,80}'|"[^"]{1,80}"/g, '<STR>']
  ];
  function mask(s) { let t = String(s || ''); for (const [re, r] of MASKS) t = t.replace(re, r); return t; }
  function tokenize(msg) { return mask(msg).split(/\s+/).filter(Boolean).slice(0, 48); }
  const isVar = (t) => t === '<*>' || /^<[A-Z]+>$/.test(t) || (/\d/.test(t) && !/^HTTP_\d{3}$/.test(t));
  function createDrain(opts) {
    const sim = (opts && opts.sim) || 0.5; const maxClusters = (opts && opts.maxClusters) || 2000;
    const groups = new Map(); const clusters = [];
    function key(tok) { return tok.length + '|' + (tok[0] && !isVar(tok[0]) ? tok[0] : '*') + '|' + (tok[1] && !isVar(tok[1]) ? tok[1] : '*'); }
    function similarity(a, b) { let same = 0; let vars = 0; for (let i = 0; i < a.length; i++) { if (a[i] === '<*>') { vars++; continue; } if (a[i] === b[i]) same++; else if (/^HTTP_/.test(a[i]) || /^HTTP_/.test(b[i] || '')) return { s: -1, vars: 0 }; } const n = a.length - vars; return { s: n > 0 ? same / n : (a.length ? 1 : 0), vars }; }
    function add(entry) {
      const tok = tokenize(entry.cmsg != null ? entry.cmsg : entry.msg); if (!tok.length) tok.push('<empty>');
      const k = key(tok); let g = groups.get(k); if (!g) { g = []; groups.set(k, g); }
      let best = null; let bs = -1; let bv = 0;
      for (const c of g) { const r = similarity(c.tokens, tok); if (r.s > bs || (r.s === bs && r.vars > bv)) { best = c; bs = r.s; bv = r.vars; } }
      let c = best;
      if (!c || bs < sim || (clusters.length >= maxClusters && false)) {
        if (clusters.length >= maxClusters) { c = clusters.find((x) => x.id === 'C-other') || mk(['<other>'], 'C-other'); }
        else { c = mk(tok.slice()); g.push(c); }
      } else { for (let i = 0; i < c.tokens.length; i++) if (c.tokens[i] !== tok[i]) c.tokens[i] = '<*>'; }
      c.count++; const lv = entry.level || 'info'; c.levels[lv] = (c.levels[lv] || 0) + 1;
      if (entry.service) c.services[entry.service] = (c.services[entry.service] || 0) + 1;
      if (entry.ts != null) { if (c.first == null || entry.ts < c.first) c.first = entry.ts; if (c.last == null || entry.ts > c.last) c.last = entry.ts; }
      if (c.sample.length < 4) c.sample.push(entry.id); c.lastId = entry.id; if (entry.flag) c.flagged++;
      return c.id;
    }
    function mk(tokens, id) { const c = { id: id || 'C' + (clusters.length + 1), tokens, count: 0, levels: {}, services: {}, first: null, last: null, sample: [], lastId: null, flagged: 0 }; clusters.push(c); return c; }
    function result() { return clusters.map((c) => ({ id: c.id, template: c.tokens.join(' '), count: c.count, levels: c.levels, services: c.services, first: c.first, last: c.last, sample: c.sample.slice(), lastId: c.lastId, flagged: c.flagged, level: topLevel(c.levels) })).sort((a, b) => b.count - a.count); }
    return { add, result, get size() { return clusters.length; } };
  }
  const RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
  /* A cluster's level is its most severe level that makes up at least a fifth of its lines (so one stray error doesn't paint an info template red). */
  function topLevel(levels) { const tot = Object.values(levels).reduce((a, b) => a + b, 0) || 1; const ls = Object.keys(levels).sort((a, b) => RANK[b] - RANK[a]); return ls.find((l) => levels[l] / tot >= 0.2) || ls[ls.length - 1] || 'info'; }
  /* Message used for clustering: access logs cluster by method, path shape and status. */
  function clusterMsg(e) { if (e.http && e.http.method && e.http.path) return 'HTTP_' + e.http.status + ' ' + e.http.method + ' ' + String(e.http.path).split('?')[0].replace(/\/[0-9a-f-]{6,}|\/\d+/gi, '/<N>'); if (e.exc && e.msg.length < 40) return e.msg + ' ' + e.exc; return e.msg; }
  /* Readable template: "HTTP_500 POST /api/x" becomes "POST /api/x \u2192 500". */
  function pretty(t) { return String(t || '').replace(/^HTTP_(\d{3}) (\S+) (.*)$/, '$2 $3 \u2192 $1'); }
  return { mask, tokenize, createDrain, clusterMsg, topLevel, pretty };
});
