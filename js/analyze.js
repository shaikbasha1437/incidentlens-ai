/* IncidentLens analysis (demo mode's rule engine): matches log lines against the known-pattern library,
   correlates with recent changes and anomalies, separates causes from symptoms, ranks root-cause hypotheses with
   a confidence, cites the exact lines behind each, and abstains with a "collect next" list when the evidence is
   thin. Lines flagged as prompt injection are excluded from every step. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./text.js'), require('./detect.js'), require('./patterns.js'), require('./commands.js'));
  else (root.IL = root.IL || {}).analyze = factory(root.IL.text, root.IL.detect, root.IL.patterns, root.IL.commands);
})(typeof self !== 'undefined' ? self : this, function (T, D, PT, K) {
  'use strict';
  const MIN = 60000;
  const sat = (n, k) => 1 - Math.exp(-n / (k || 4));
  const text = (e) => e.msg + (e.trace ? '\n' + e.trace.join('\n') : '') + (e.exc ? '\n' + e.exc : '');
  const HOST = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:example|internal|local|svc|com|net|io|org|cluster\.local))\b/i;
  function majority(arr) { const m = new Map(); for (const x of arr) if (x) m.set(x, (m.get(x) || 0) + 1); let best = null; let n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v; } return best; }
  /* Pick up to `max` evidence lines: the first line of each distinct cluster, earliest first. */
  function pickEvidence(list, max) { const seen = new Set(); const out = []; for (const e of list) { if (seen.has(e.c)) continue; seen.add(e.c); out.push(e); if (out.length >= max) break; } if (out.length < Math.min(max, 3)) for (const e of list) { if (out.includes(e)) continue; out.push(e); if (out.length >= Math.min(max, 3)) break; } return out.sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.id - b.id); }
  const fmtT = (t) => (t == null ? 'unknown time' : new Date(t).toISOString().slice(11, 16) + ' UTC');
  function analyze(res, opts) {
    const o = opts || {}; const changes = (o.changes || []).filter((c) => !c.flag); const ctxIn = o.context || {};
    const det = D.detect(res, { metrics: o.metrics, changes });
    const all = res.entries || []; const entries = all.filter((e) => !e.flag); const byId = new Map(all.map((e) => [e.id, e]));
    const patterns = (o.patterns || PT.PATTERNS).filter((p) => !p.disabled).map((p) => (p.signals && p.signals[0] && p.signals[0].rx !== undefined ? p : PT.compile(p)));
    const start = det.start != null ? det.start : res.stats && res.stats.first;
    const newSigs = det.anomalies.filter((a) => a.kind === 'new-signature'); const spikes = det.anomalies.filter((a) => a.kind === 'spike' || a.kind === 'metric-errors'); const lat = det.anomalies.find((a) => a.kind === 'latency');
    const memUp = det.anomalies.some((a) => a.kind === 'memory');
    const cands = [];
    for (const p of patterns) {
      const sig = p.signals.filter((s) => s.rx).map((s) => ({ s, hits: [] }));
      for (const e of entries) { const t = text(e); for (const x of sig) if (x.s.rx.test(t)) x.hits.push(e); }
      let score = 0; const notes = []; let correlated = null; let cService = null;
      // Deploy correlation (bad deploys): new signatures or spikes within 20 min after a deploy.
      if (p.deployCorrelated) {
        let best = null;
        for (const c of changes.filter((x) => (p.changeTypes || []).includes(x.type))) {
          const win = (t) => t != null && t >= c.ts && t <= c.ts + 20 * MIN;
          const sigs = newSigs.filter((a) => win(a.at) && (a.level !== 'warn') && (!c.service || (a.services || []).includes(c.service)));
          const sp = spikes.filter((a) => win(a.at)); const lj = lat && win(lat.at);
          const b = (sigs.length ? 2.5 + Math.min(1, (sigs.length - 1) * 0.5) : 0) + (sp.length ? 1 : 0) + (lj ? 0.4 : 0);
          if (sigs.length && b > (best ? best.b : 0)) best = { c, b, sigs, sp };
        }
        if (best) { score += best.b; correlated = { change: best.c.id, minutes: Math.round(((best.sigs[0] || best.sp[0]).at - best.c.ts) / MIN), why: best.sigs.length + ' new error signature(s) in ' + (best.c.service || 'the deployed service') + ' began ' + Math.max(0, Math.round((best.sigs[0].at - best.c.ts) / MIN)) + ' min after this deploy' }; cService = best.c.service; }
      }
      let causeN = 0; const sigOut = [];
      for (const x of sig) {
        let n = x.hits.length;
        if (p.deployCorrelated && x.s.role === 'cause' && correlated) { const svc = cService; const after = changes.find((c) => c.id === correlated.change).ts; x.hits = x.hits.filter((e) => e.ts == null || e.ts >= after - MIN); n = x.hits.filter((e) => !svc || e.service === svc).length + 0.5 * x.hits.filter((e) => svc && e.service !== svc).length; }
        const w = x.s.weight || 1; const part = w * sat(n);
        if (x.s.role === 'cause') { score += part; causeN += x.hits.length; } else if (x.s.role === 'symptom') score += 0.5 * part; else score += 0.3 * part;
        sigOut.push({ id: x.s.id, label: x.s.label, role: x.s.role, count: x.hits.length, first: x.hits.length ? x.hits[0].ts : null });
      }
      if (p.deployCorrelated && !correlated) score *= 0.3;
      if (!causeN && !(p.deployCorrelated && correlated)) continue;
      const causeSig = sig.filter((x) => x.s.role === 'cause').sort((a, b) => (b.s.weight || 1) - (a.s.weight || 1)); const causeHits = Array.from(new Set(causeSig.flatMap((x) => x.hits.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.id - b.id))));
      const sympHits = sig.filter((x) => x.s.role !== 'cause').flatMap((x) => x.hits).filter((e) => !causeHits.includes(e)).sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.id - b.id);
      // Other changes: config/infra changes whose description mentions this pattern's keywords, shortly before the start.
      if (!p.deployCorrelated && start != null) {
        const kw = (p.changeKeywords || []).map((k) => k.toLowerCase());
        const c = changes.filter((x) => x.ts <= start + 2 * MIN && start - x.ts <= 90 * MIN && (p.changeTypes || []).includes(x.type) && kw.some((k) => (x.desc + ' ' + (x.service || '')).toLowerCase().includes(k))).pop();
        if (c) { score += 1.5; correlated = { change: c.id, minutes: Math.round((start - c.ts) / MIN), why: 'this ' + c.type + ' change mentions ' + kw.filter((k) => (c.desc + ' ' + (c.service || '')).toLowerCase().includes(k)).slice(0, 2).join(' and ') + (Math.round((start - c.ts) / MIN) <= 0 ? ' and landed just before the first anomaly' : ' and landed ' + Math.round((start - c.ts) / MIN) + ' min before the first anomaly') }; }
      }
      if (p.roundHour && causeHits.length && causeHits[0].ts != null && causeHits[0].ts % (60 * MIN) < 3 * MIN) { score += 0.8; notes.push('Failures begin right at ' + fmtT(causeHits[0].ts - (causeHits[0].ts % (60 * MIN))) + ', an exact hour, which is typical of an expiry.'); }
      if (p.metric && p.metric.direction === 'up' && memUp) { score += 1; notes.push('Memory metric climbs steadily before the kills.'); }
      // Timing: a cause should show up before or with the symptoms; lines that only start long after are likely consequences.
      const firstCause = causeHits.length ? Math.min(...causeHits.map((e) => (e.ts == null ? Infinity : e.ts))) : null;
      if (firstCause != null && start != null) { if (firstCause <= start + 3 * MIN) score += 0.3; else if (firstCause > start + 10 * MIN) { score *= 0.7; notes.push('These lines start ' + Math.round((firstCause - start) / MIN) + ' min after the first anomaly, so they may be a consequence.'); } }
      const evC = pickEvidence(causeHits, 6); const evS = pickEvidence(sympHits, 4);
      const service = cService || majority(causeHits.map((e) => e.service)) || majority(entries.filter((e) => e.level === 'error').map((e) => e.service));
      cands.push({ pattern: p, score, causeN, causeHits, sympHits, evC, evS, sig: sigOut, correlated, service, notes });
    }
    cands.sort((a, b) => b.score - a.score);
    const topS = cands[0] ? cands[0].score : 0;
    const hyps = cands.map((c, i) => {
      const second = i === 0 ? (cands[1] ? cands[1].score : 0) : topS;
      const raw = sat(c.score, 3.5); const m = i === 0 ? second / (c.score || 1) : Math.min(1, c.score / (topS || 1));
      const confidence = Math.round(100 * (i === 0 ? raw * (1 - 0.35 * m * m) : raw * 0.85 * (1 - 0.35 * (1 - m) * 0) * Math.min(1, c.score / (topS || 1)))) / 100;
      const chg = c.correlated ? changes.find((x) => x.id === c.correlated.change) : null;
      const evText = c.evC.map(text).join('\n');
      const hostM = HOST.exec(evText); const pods = /\b([a-z][a-z0-9-]*-[a-z0-9]{8,10}-[a-z0-9]{5})\b/.exec(c.causeHits.concat(c.sympHits).map(text).join('\n'));
      const ctx = Object.assign({ service: c.service, ns: ctxIn.ns || null, version: chg && chg.version, prev: chg && chg.prev, host: hostM && hostM[1], pod: pods && pods[1], db: (/\b([a-z0-9-]*(?:db|postgres|pg|mysql)[a-z0-9-]*(?:\.[a-z0-9-]+)+)\b/i.exec(c.causeHits.concat(c.sympHits).map(text).join('\n')) || [])[1] || ctxIn.db, cert: hostM ? hostM[1].split('.')[0] + '-tls' : null }, Object.fromEntries(Object.entries(ctxIn).filter(([, v]) => v)));
      const sigs = c.sig.filter((s) => s.count); const cause = sigs.filter((s) => s.role === 'cause'); const symp = sigs.filter((s) => s.role === 'symptom');
      const explanation = [
        cause.length ? cause.map((s) => s.count + ' line(s) show ' + s.label.toLowerCase()).join('; ') + ', starting ' + fmtT(cause[0].first) + '.' : 'No direct cause lines; this rests on timing.',
        c.correlated && chg ? 'Correlated change: ' + chg.type + ' of ' + (chg.service || 'a service') + (chg.version ? ' ' + chg.version : '') + ' at ' + fmtT(chg.ts) + ' (' + c.correlated.why + ').' : '',
        symp.length ? 'Symptoms that follow from it: ' + symp.map((s) => s.label.toLowerCase() + ' (' + s.count + ')').join(', ') + '.' : ''
      ].concat(c.notes).filter(Boolean).join(' ');
      return { id: c.pattern.id, patternId: c.pattern.id, title: c.pattern.title, category: c.pattern.category, summary: K.fill(c.pattern.cause || c.pattern.summary, ctx).replace(/<(\w+)>/g, (mm, k) => ({ version: 'the new release', prev: 'the previous release', host: 'the remote host', service: 'the service' }[k] || mm)), score: Math.round(c.score * 100) / 100, confidence, causeEvidence: c.evC.map((e) => e.id), symptomEvidence: c.evS.map((e) => e.id), causeCount: c.causeHits.length, symptomCount: c.sympHits.length, signals: c.sig, correlated: c.correlated, service: c.service, ctx, explanation, fixes: fixesFor(c.pattern, ctx), collect: (c.pattern.collect || []).map((x) => K.fill(x, ctx)), clusters: Array.from(new Set(c.causeHits.map((e) => e.c))), symptomClusters: Array.from(new Set(c.sympHits.map((e) => e.c))) };
    });
    // Abstain when the evidence is thin or two explanations are nearly tied.
    const top = hyps[0]; let abstain = null;
    if (!top) abstain = { reason: 'No known failure pattern matched any cause line, and no deploy lines up with the errors.' };
    else if (top.causeCount < 3 && !(top.correlated && top.causeCount >= 1)) abstain = { reason: 'Only ' + top.causeCount + ' line(s) support the best match (' + top.title + '). That is not enough to call it a root cause.' };
    else if (top.confidence < 0.5) abstain = { reason: 'The best match (' + top.title + ') has low confidence (' + Math.round(top.confidence * 100) + '%).' };
    else if (hyps[1] && hyps[1].score >= top.score * 0.85 && top.confidence < 0.75) abstain = { reason: top.title + ' and ' + hyps[1].title + ' are nearly tied. More data is needed to tell them apart.' };
    if (abstain) abstain.collect = collectNext(res, det, hyps, entries);
    // Contributing factors: earlier changes to the top service in the 24 h before the start.
    const contributing = [];
    if (top && !abstain) { for (const c of changes) if (start != null && c.ts < start && start - c.ts <= 24 * 60 * MIN && (!top.correlated || c.id !== top.correlated.change) && (c.service === top.service || (top.ctx.host && c.desc.includes(top.ctx.host)))) contributing.push({ change: c.id, text: c.type + ' of ' + (c.service || '?') + (c.version ? ' ' + c.version : '') + ' at ' + fmtT(c.ts) + ', ' + Math.round((start - c.ts) / MIN) + ' min before the first anomaly. Worth checking: it may have introduced the condition.' }); }
    // Which anomalies are symptoms of the top cause.
    const sympIds = new Set(top ? top.symptomClusters : []); const causeIds = new Set(top ? top.clusters : []);
    const anomalies = det.anomalies.map((a) => Object.assign({}, a, { role: !top || abstain ? 'unexplained' : a.cluster && causeIds.has(a.cluster) ? 'cause' : a.kind === 'oom' && top.patternId === 'memory-leak-oom' ? 'cause' : a.cluster && sympIds.has(a.cluster) ? 'symptom' : /spike|latency|crashloop|metric-errors/.test(a.kind) ? 'symptom' : a.kind === 'memory' && top.patternId === 'memory-leak-oom' ? 'cause' : 'unexplained' }));
    const past = similarPast(o.past || PT.PAST, top, res);
    return { detect: Object.assign({}, det, { anomalies }), hypotheses: hyps, top: abstain ? null : top, abstain, contributing, past, flaggedExcluded: all.length - entries.length, considered: entries.length, byId };
  }
  function fixesFor(p, ctx) { return (p.fixes || []).map((f) => ({ id: f.id, title: K.fill(f.title, ctx).replace(/<(\w+)>/g, (m, k) => ({ prev: 'the previous release', service: 'the service', host: 'the host' }[k] || m)), why: f.why ? K.fill(f.why, ctx) : '', steps: (f.steps || []).map((s) => K.fill(s, ctx)), commands: (f.commands || []).map((c) => { const cmd = K.fill(c.cmd, ctx); return { cmd, note: c.note ? K.fill(c.note, ctx) : '', risk: K.classify(cmd) }; }), simulate: f.simulate ? K.fill(f.simulate, ctx) : null })); }
  function collectNext(res, det, hyps, entries) {
    const out = []; const add = (x) => { if (x && !out.includes(x)) out.push(x); };
    const svc5 = majority(entries.filter((e) => e.http && e.http.status >= 500).map((e) => e.service));
    const n5 = entries.filter((e) => e.http && e.http.status >= 500).length;
    if (n5) add(n5 + ' HTTP 5xx line(s) with no cause in these logs: collect the upstream application logs' + (svc5 ? ' behind ' + svc5 : '') + ' for the same minutes.');
    if (det.anomalies.some((a) => a.kind === 'latency')) add('Latency rose: collect per-dependency latency (database, cache, outbound calls) and traces for slow requests.');
    if (!det.anomalies.some((a) => a.kind === 'spike')) add('Errors are scattered, not a spike: correlate each error with host or pod to see whether one instance is bad.');
    for (const h of hyps.slice(0, 2)) for (const c of h.collect.slice(0, 2)) add(c + ' (to confirm or rule out ' + h.title.toLowerCase() + ')');
    if (!(res.stats && res.stats.first)) add('Most lines have no timestamps: export logs with timestamps so the timeline can line up with changes.');
    add('The deploy and config change list for the hour before the first error.');
    add('Load balancer or ingress logs with upstream address and upstream response time.');
    return out.slice(0, 7);
  }
  function similarPast(past, top, res) {
    if (!past || !past.length) return [];
    const docs = past.map((p) => ({ id: p.id, text: [p.title, p.service, p.rootCause, p.fix, (p.tags || []).join(' '), p.patternId].join(' '), p }));
    const idx = T.bm25(docs);
    const q = [top ? top.title + ' ' + top.service + ' ' + top.patternId : '', (res.clusters || []).filter((c) => c.level === 'error' || c.level === 'fatal').slice(0, 5).map((c) => c.template.replace(/<\w+>|<\*>/g, ' ')).join(' ')].join(' ');
    return idx.search(q, { limit: 5 }).map((r) => ({ id: r.doc.id, title: r.doc.p.title, date: r.doc.p.date, service: r.doc.p.service, patternId: r.doc.p.patternId, rootCause: r.doc.p.rootCause, fix: r.doc.p.fix, score: Math.round(r.score * 100) / 100 + (top && r.doc.p.patternId === top.patternId ? 2 : 0), samePattern: !!(top && r.doc.p.patternId === top.patternId) })).filter((x) => x.samePattern || x.score >= 2.5).sort((a, b) => b.score - a.score).slice(0, 3);
  }
  return { analyze, fixesFor, collectNext, similarPast, text };
});
