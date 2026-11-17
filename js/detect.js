/* IncidentLens detection: metrics and change-list parsing, timeline buckets, and anomaly detection
   (error spikes, new error signatures, latency jumps, OOM kills and crash loops, memory climbing). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parse.js'), require('./redact.js'), require('./guard.js'), require('./cluster.js'));
  else (root.IL = root.IL || {}).detect = factory(root.IL.parse, root.IL.redact, root.IL.guard, root.IL.cluster);
})(typeof self !== 'undefined' ? self : this, function (P, R, G, C) {
  'use strict';
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const p95 = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
  /* Metrics CSV: wide (timestamp,metricA,metricB...) or long (timestamp,metric,value[,service]). */
  function parseMetrics(text, opts) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() && !/^#/.test(l)); if (lines.length < 2) return { series: [], errors: lines.length ? ['Metrics need a header row and at least one data row.'] : [] };
    const head = P.splitCsv(lines[0]).map((h) => h.trim()); const lower = head.map((h) => h.toLowerCase());
    const ti = lower.findIndex((h) => /^(timestamp|time|ts|date|datetime|minute|@timestamp)$/.test(h)); if (ti < 0) return { series: [], errors: ['Metrics need a timestamp column (timestamp, time or date).'] };
    const mi = lower.indexOf('metric'); const vi = lower.indexOf('value'); const map = new Map(); let bad = 0;
    for (const l of lines.slice(1)) {
      const f = P.splitCsv(l); const t = P.parseTs(f[ti], opts); if (t == null) { bad++; continue; }
      if (mi >= 0 && vi >= 0) { const name = (f[mi] || '').trim(); const v = parseFloat(f[vi]); if (name && isFinite(v)) { if (!map.has(name)) map.set(name, []); map.get(name).push({ t, v }); } }
      else head.forEach((h, i) => { if (i === ti) return; const v = parseFloat(f[i]); if (!isFinite(v)) return; if (!map.has(h)) map.set(h, []); map.get(h).push({ t, v }); });
    }
    const series = Array.from(map.entries()).map(([name, points]) => ({ name, points: points.sort((a, b) => a.t - b.t) })).filter((s) => s.points.length);
    return { series, errors: bad ? [bad + ' row(s) had no readable timestamp and were skipped.'] : [] };
  }
  const CHANGE_TYPES = 'deploy|release|rollout|rollback|config|flag|feature-flag|infra|migration|cert|dns|network|traffic|scale|secret';
  /* Change list: JSON array, CSV with time/type/service/description columns, or lines "<time> <type> <service> <description>". */
  function parseChanges(text, opts) {
    const out = []; const errors = []; const s = String(text || '').trim(); if (!s) return { changes: out, errors };
    const push = (c, raw) => {
      const red = R.line([c.desc, c.service, c.version].filter(Boolean).join(' \u2016 ')).hits.length ? R.line(c.desc || '').text : c.desc;
      const flag = G.rules([c.desc, c.service].join(' ')); const desc = String(red || '').replace(/"/g, '').trim();
      const verRe = /(?:^|[\s("'])(v\d+\.\d+\.\d+(?:[-+][\w.]+)?|\d+\.\d+\.\d+(?:-[\w.]+)?)(?![.\d])/; const isRel = /^(deploy|release|rollout|rollback)$/i.test(c.type || '');
      const version = c.version || (isRel || /\bv\d/.test(desc) ? (verRe.exec(desc) || [])[1] : null) || null;
      const prev = c.prev || (isRel || /\bv\d/.test(desc) ? (/\b(?:prev(?:ious)?|from|was)\s*[:=]?\s*(v?\d+\.\d+\.\d+(?:[-+][\w.]+)?)(?![.\d])/i.exec(desc) || [])[1] : null) || null;
      out.push({ id: 'chg-' + (out.length + 1), ts: c.ts, type: String(c.type || 'change').toLowerCase(), service: c.service || null, version: version && version !== prev ? version : version, prev, desc, raw: R.line(raw || '').text, flag: flag.length ? flag : undefined });
    };
    if (s[0] === '[') { try { for (const c of JSON.parse(s)) { const ts = P.parseTs(c.ts || c.time || c.timestamp || c.at, opts); if (ts == null) { errors.push('A change had no readable time.'); continue; } push({ ts, type: c.type || c.kind, service: c.service || c.app, version: c.version, prev: c.prev || c.previous, desc: c.description || c.desc || c.summary || c.message || '' }, JSON.stringify(c)); } } catch (e) { errors.push('Could not read the change list as JSON: ' + e.message); } return { changes: out.sort((a, b) => a.ts - b.ts), errors }; }
    const lines = s.split(/\r?\n/).filter((l) => l.trim() && !/^#/.test(l)); const hdr = P.splitCsv(lines[0]).map((h) => h.trim().toLowerCase()); const isCsv = hdr.length >= 3 && hdr.some((h) => /^(time|timestamp|ts|date|at)$/.test(h)) && hdr.some((h) => /^(type|kind|change)$/.test(h));
    if (isCsv) { const ix = (re) => hdr.findIndex((h) => re.test(h)); const ti = ix(/^(time|timestamp|ts|date|at)$/); const ki = ix(/^(type|kind|change)$/); const si = ix(/^(service|app|component|system)$/); const di = ix(/^(description|desc|summary|details|message|notes?)$/); const vi = ix(/^version$/); const pi = ix(/^(prev|previous|from)$/);
      for (const l of lines.slice(1)) { const f = P.splitCsv(l); const ts = P.parseTs(f[ti], opts); if (ts == null) { errors.push('Skipped a change row with no readable time.'); continue; } push({ ts, type: f[ki], service: si >= 0 ? f[si] : null, version: vi >= 0 ? f[vi] : null, prev: pi >= 0 ? f[pi] : null, desc: di >= 0 ? f[di] : '' }, l); } return { changes: out.sort((a, b) => a.ts - b.ts), errors }; }
    const re = new RegExp('^(\\S+(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:?\\d{2})?)?)\\s+(' + CHANGE_TYPES + ')\\s+(\\S+)\\s*(.*)$', 'i');
    for (const l of lines) { const m = re.exec(l.trim()); if (!m) { errors.push('Could not read: ' + R.line(l).text.slice(0, 80)); continue; } const ts = P.parseTs(m[1], opts); if (ts == null) { errors.push('No readable time in: ' + R.line(l).text.slice(0, 80)); continue; } push({ ts, type: m[2], service: m[3], desc: m[4] }, l); }
    return { changes: out.sort((a, b) => a.ts - b.ts), errors };
  }
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 720, 1440].map((m) => m * 60000);
  function chooseBucket(first, last, max) { const range = Math.max(60000, (last || 0) - (first || 0)); return STEPS.find((s) => range / s <= (max || 90)) || STEPS[STEPS.length - 1]; }
  /* Re-bucket the per-minute counts for the timeline. */
  function buckets(minutes, size) {
    if (!minutes.length) return [];
    const start = Math.floor(minutes[0].t / size) * size; const end = minutes[minutes.length - 1].t; const out = [];
    for (let t = start; t <= end; t += size) out.push({ t, n: 0, warn: 0, error: 0, s5xx: 0, s4xx: 0, req: 0, latSum: 0, latN: 0, lats: [] });
    for (const m of minutes) { const b = out[Math.floor((m.t - start) / size)]; if (!b) continue; b.n += m.n; b.warn += m.warn; b.error += m.error; b.s5xx += m.s5xx; b.s4xx += m.s4xx || 0; b.req += m.req; b.latSum += m.latSum; b.latN += m.latN; if (b.lats.length < 400) b.lats.push(...(m.lats || []).slice(0, 400 - b.lats.length)); }
    return out.map((b) => ({ t: b.t, n: b.n, warn: b.warn, error: b.error, s5xx: b.s5xx, s4xx: b.s4xx, req: b.req, lat: b.latN ? b.latSum / b.latN : null, p95: p95(b.lats) }));
  }
  const OOM = /OOMKill(?:ed|ing)|exit code:? 137|Out of memory: Killed process|java\.lang\.OutOfMemoryError|JavaScript heap out of memory|Reached heap limit|MemoryError|memory limit exceeded|runtime: out of memory/i;
  const LOOP = /CrashLoopBackOff|Back-off restarting failed container/i; const RESTART_COUNT = /Restart Count:\s*(\d+)/i; const STARTED = /\b(Started container|Starting \S+ v?\d|server listening on|Listening on port)\b/i;
  const text = (e) => e.msg + (e.trace ? '\n' + e.trace.join('\n') : '') + (e.exc ? '\n' + e.exc : '');
  /* Find anomalies. Returns { size, buckets, anomalies, start (incident start), baselineEnd } */
  function detect(res, opts) {
    const o = opts || {}; const st = res.stats || {}; const first = st.first; const last = st.last; const entries = (res.entries || []).filter((e) => !e.flag);
    const size = chooseBucket(first, last); const bs = buckets(res.minutes || [], size); const anomalies = [];
    const nb = bs.length; const baseN = Math.max(1, Math.floor(nb * 0.3)); const baselineEnd = nb ? bs[Math.min(nb - 1, baseN - 1)].t + size : first;
    const add = (a) => { a.id = 'A' + (anomalies.length + 1); anomalies.push(a); };
    // Error spikes.
    if (nb >= 4) {
      const errs = bs.map((b) => b.error); const base = median(errs.slice(0, baseN)); const baseMean = mean(errs.slice(0, baseN));
      const thr = Math.max(5, 3 * base + 4, 2 * (baseMean + 1));
      let i = 0;
      while (i < nb) {
        if (errs[i] >= thr && bs[i].t >= baselineEnd - size) { let j = i; while (j + 1 < nb && (errs[j + 1] >= thr * 0.4 || (j + 2 < nb && errs[j + 2] >= thr * 0.6) || (j + 3 < nb && errs[j + 3] >= thr))) j++; const from = bs[i].t; const to = bs[j].t + size; const peak = Math.max(...errs.slice(i, j + 1)); const ev = entries.filter((e) => e.ts >= from && e.ts < to && (e.level === 'error' || e.level === 'fatal')).slice(0, 3).map((e) => e.id); add({ kind: 'spike', title: 'Error spike', at: from, until: to, severity: peak >= thr * 4 ? 'high' : 'medium', detail: 'Errors peaked at ' + peak + ' per ' + (size / 60000) + ' min, against a baseline of about ' + Math.round(baseMean * 10) / 10 + '.', evidence: ev, peak, base: baseMean }); i = j + 1; }
        else i++;
      }
    }
    // New error signatures: error/warn templates first seen after the baseline window.
    const range = (last || 0) - (first || 0);
    if (range > 0) {
      const fresh = (res.clusters || []).filter((c) => (c.level === 'error' || c.level === 'fatal' || c.level === 'warn') && c.count >= 3 && c.first != null && c.first >= first + Math.max(range * 0.2, Math.min(range * 0.3, baselineEnd - first)) && c.flagged < c.count / 2).sort((a, b) => b.count - a.count).slice(0, 6);
      for (const c of fresh) add({ kind: 'new-signature', title: 'New ' + (c.level === 'warn' ? 'warning' : 'error') + ' signature', at: c.first, until: c.last, severity: c.level === 'warn' ? 'low' : c.count >= 20 ? 'high' : 'medium', detail: c.count + '\u00d7 "' + C.pretty(c.template).slice(0, 120) + '"', evidence: c.sample.slice(0, 3), cluster: c.id, level: c.level, services: Object.keys(c.services) });
    }
    // Latency jumps: from access logs, else from a latency metric.
    let lat = bs.filter((b) => b.p95 != null).map((b) => ({ t: b.t, v: b.p95 })); let latName = 'p95 latency (from logs)';
    const ms = (o.metrics && o.metrics.series) || [];
    const lm = ms.find((s) => /p9\d|latency|duration|response/i.test(s.name)); if (lat.length < 6 && lm) { lat = lm.points; latName = lm.name; }
    if (lat.length >= 6) {
      const bn = Math.max(2, Math.floor(lat.length * 0.3)); const base = median(lat.slice(0, bn).map((p) => p.v));
      for (let i = bn; i < lat.length - 1; i++) { const a = lat[i].v; const b = lat[i + 1].v; const thr = Math.max(base * 2, base + 100); if (a >= thr && b >= thr) { const after = median(lat.slice(i, Math.min(lat.length, i + 6)).map((p) => p.v)); add({ kind: 'latency', title: 'Latency jump', at: lat[i].t, until: null, severity: after >= base * 4 ? 'high' : 'medium', detail: latName + ' rose from about ' + Math.round(base) + ' ms to ' + Math.round(after) + ' ms.', evidence: entries.filter((e) => e.http && e.http.ms != null && e.ts >= lat[i].t && e.http.ms >= thr).slice(0, 3).map((e) => e.id), base, after }); break; } }
    }
    // OOM kills and crash loops.
    const oom = entries.filter((e) => OOM.test(text(e))); if (oom.length) add({ kind: 'oom', title: 'Out-of-memory kills', at: oom[0].ts, until: oom[oom.length - 1].ts, severity: 'high', detail: oom.length + ' line(s) report an out-of-memory kill or heap exhaustion.', evidence: oom.slice(0, 4).map((e) => e.id) });
    const loop = entries.filter((e) => LOOP.test(text(e))); let maxRestarts = 0; for (const e of entries) { const m = RESTART_COUNT.exec(text(e)); if (m) maxRestarts = Math.max(maxRestarts, +m[1]); }
    const starts = entries.filter((e) => STARTED.test(e.msg)).length;
    if (loop.length >= 2 || maxRestarts >= 3 || starts >= 4) add({ kind: 'crashloop', title: 'Restarts / crash loop', at: (loop[0] || entries.find((e) => STARTED.test(e.msg)) || {}).ts, until: null, severity: 'high', detail: [loop.length ? loop.length + ' back-off event(s)' : '', maxRestarts ? 'restart count up to ' + maxRestarts : '', starts >= 4 ? starts + ' process starts' : ''].filter(Boolean).join(', ') + '.', evidence: loop.slice(0, 3).map((e) => e.id) });
    // Memory climbing in metrics.
    const mem = ms.find((s) => /mem|heap|rss/i.test(s.name));
    if (mem && mem.points.length >= 6) { const n = mem.points.length; const a = mean(mem.points.slice(0, Math.ceil(n / 3)).map((p) => p.v)); const peak = Math.max(...mem.points.map((p) => p.v)); if (peak >= a * 1.6) { const at = (mem.points.find((p) => p.v >= a * 1.3) || mem.points[0]).t; add({ kind: 'memory', title: 'Memory climbing', at, until: null, severity: 'medium', detail: mem.name + ' climbed from about ' + Math.round(a) + ' to a peak of ' + Math.round(peak) + '.', evidence: [], metric: mem.name }); } }
    // Error-rate metric when logs have no HTTP lines.
    const er = ms.find((s) => /5xx|error|fail/i.test(s.name)); if (er && !anomalies.some((a) => a.kind === 'spike') && er.points.length >= 6) { const bn = Math.max(2, Math.floor(er.points.length * 0.3)); const base = median(er.points.slice(0, bn).map((p) => p.v)); const hit = er.points.find((p, i) => i >= bn && p.v >= Math.max(base * 3, base + 1)); if (hit) add({ kind: 'metric-errors', title: 'Error rate up (metrics)', at: hit.t, until: null, severity: 'medium', detail: er.name + ' rose from about ' + Math.round(base * 100) / 100 + ' to ' + Math.round(hit.v * 100) / 100 + '.', evidence: [] }); }
    // Link anomalies to the latest change shortly before them.
    const changes = (o.changes || []).filter((c) => !c.flag);
    for (const a of anomalies) { if (a.at == null) continue; const c = changes.filter((x) => x.ts <= a.at && a.at - x.ts <= 30 * 60000).pop(); if (c) a.after = { change: c.id, minutes: Math.round((a.at - c.ts) / 60000) }; }
    anomalies.sort((x, y) => (x.at || 0) - (y.at || 0));
    const realKinds = anomalies.filter((a) => a.kind !== 'memory');
    const start = realKinds.length ? Math.min(...realKinds.map((a) => a.at).filter((x) => x != null)) : null;
    return { size, buckets: bs, anomalies, start, baselineEnd };
  }
  return { parseMetrics, parseChanges, chooseBucket, buckets, detect, median, mean, p95, OOM };
});
