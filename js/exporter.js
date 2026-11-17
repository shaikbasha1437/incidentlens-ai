/* IncidentLens drafts and exports: status updates for Slack, the status page and stakeholders (drafts only,
   never sent), a blameless postmortem draft, the incident report, a CSV of log clusters and the JSON backup.
   Exports never include settings or API keys. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./guard.js'));
  else (root.IL = root.IL || {}).exporter = factory(root.IL.guard);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';
  const STATUSES = [{ id: 'investigating', label: 'Investigating' }, { id: 'identified', label: 'Identified' }, { id: 'monitoring', label: 'Monitoring' }, { id: 'resolved', label: 'Resolved' }];
  const SEVS = [{ id: 'SEV1', label: 'SEV1 \u00b7 critical' }, { id: 'SEV2', label: 'SEV2 \u00b7 major' }, { id: 'SEV3', label: 'SEV3 \u00b7 minor' }, { id: 'SEV4', label: 'SEV4 \u00b7 low' }];
  const statusLabel = (s) => (STATUSES.find((x) => x.id === s) || { label: s }).label;
  const utc = (t) => (t == null ? 'unknown' : new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
  const hm = (t) => (t == null ? '--:--' : new Date(t).toISOString().slice(11, 16));
  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? '"' + (/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
  /* Impact numbers from the parsed logs. */
  function impact(res, an) {
    const start = an && an.detect.start; const errs = res.entries.filter((e) => !e.flag && (e.level === 'error' || e.level === 'fatal') && (start == null || e.ts == null || e.ts >= start));
    const lastErr = errs.length ? Math.max(...errs.map((e) => e.ts || 0)) : null; const http = res.entries.filter((e) => e.http && (start == null || e.ts >= start)); const h5 = http.filter((e) => e.http.status >= 500).length;
    return { start, lastErr, minutes: start != null && lastErr ? Math.max(1, Math.round((lastErr - start) / 60000)) : null, errors: errs.length, requests: http.length, failed: h5, failRate: http.length ? Math.round((h5 / http.length) * 1000) / 10 : null, services: Array.from(new Set(errs.map((e) => e.service).filter(Boolean))).slice(0, 5) };
  }
  function nextStep(inc, an) {
    if (inc.status === 'resolved') return 'Resolved. A postmortem will follow.';
    if (inc.status === 'monitoring') return 'A fix is in place and we are watching error rates.';
    if (an && an.top && an.top.fixes[0]) return 'Next: ' + an.top.fixes[0].title.replace(/^./, (c) => c.toLowerCase()) + '.';
    return 'Next: collecting more data (' + ((an && an.abstain && an.abstain.collect[0]) || 'logs from upstream services').replace(/\.$/, '') + ').';
  }
  function statusDrafts(inc, res, an, company) {
    const co = company || {}; const im = impact(res, an); const top = an && an.top; const st = statusLabel(inc.status);
    const hyp = top ? top.title + ' (' + Math.round(top.confidence * 100) + '% confidence, ' + (top.correlated ? 'lines up with a recent change' : 'from log evidence') + ')' : 'not yet determined; collecting more data';
    const imp = [im.failRate != null ? im.failRate + '% of requests in the logs failed since ' + hm(im.start) + ' UTC' : null, im.errors ? im.errors + ' error lines' : null, im.services.length ? 'services: ' + im.services.join(', ') : null].filter(Boolean).join('; ') || 'still being assessed';
    const slack = { to: co.incidentChannel || '#incidents', subject: inc.id + ' ' + inc.sev + ' \u00b7 ' + st, body: [':rotating_light: *' + inc.id + ' (' + inc.sev + '): ' + inc.title + '*', '*Status:* ' + st, '*Impact:* ' + imp, '*Current hypothesis:* ' + hyp, '*' + nextStep(inc, an) + '*', '*Owner:* ' + (inc.owner || 'unassigned') + ' \u00b7 *IC:* ' + (inc.commander || 'unassigned'), 'Next update in ' + (inc.status === 'resolved' ? '24 hours (postmortem)' : '30 minutes') + '.'].join('\n') };
    const publicWhat = { investigating: 'We are investigating reports that some customers are seeing errors' + (inc.publicArea ? ' when using ' + inc.publicArea : '') + '.', identified: 'We have identified the cause of the errors and are applying a fix.', monitoring: 'A fix has been applied. We are monitoring to make sure things stay healthy.', resolved: 'This incident has been resolved. Everything is working normally.' }[inc.status] || 'We are investigating.';
    const statuspage = { to: co.statusPage || 'status page', subject: (inc.publicTitle || inc.title) + ' \u2013 ' + st, body: [publicWhat, inc.status === 'resolved' ? 'We are sorry for the disruption. We will publish a summary of what happened.' : 'We will post another update within 30 minutes.'].join('\n\n') };
    const stakeholders = { to: co.leadership || 'leadership', subject: '[' + inc.sev + '] ' + inc.id + ' ' + inc.title + ' \u2013 ' + st, body: ['Hi all,', '', 'Summary: ' + inc.title + '. Status: ' + st + '.', 'Impact: ' + imp + (im.minutes ? '; about ' + im.minutes + ' minutes so far.' : '.'), 'Likely cause: ' + (top ? top.summary : 'not yet determined. We are collecting more data before naming a cause.'), nextStep(inc, an), '', 'Incident commander: ' + (inc.commander || 'unassigned') + '. Owner: ' + (inc.owner || 'unassigned') + '.', '', 'This is a draft prepared from logs. Please check the numbers before sending.'].join('\n') };
    return { slack, statuspage, stakeholders };
  }
  const BLAME = [/\bhuman error\b/i, /\bcareless(ly|ness)?\b/i, /\bshould have known\b/i, /\b(his|her|their) fault\b/i, /\bfault of\b/i, /\bblame[ds]?\b/i, /\bnegligen(t|ce)\b/i, /\bincompeten(t|ce)\b/i, /\bfailed to notice\b/i, /\bstupid\b/i, /\blazy\b/i, /\bscrewed up\b/i, /\bmessed up\b/i, /\bdidn'?t bother\b/i];
  /* Flags wording that blames people instead of systems. */
  function blameLint(text) { const out = []; String(text || '').split(/\n/).forEach((l, i) => { for (const re of BLAME) { const m = re.exec(l); if (m) out.push({ line: i + 1, word: m[0], text: l.trim().slice(0, 140) }); } }); return out; }
  function plusDays(t, d) { return new Date(t + d * 86400000).toISOString().slice(0, 10); }
  function postmortem(inc, res, an, now) {
    const im = impact(res, an); const top = an && an.top; const byId = an ? an.byId : new Map(); const t = now || Date.now();
    const timeline = [];
    for (const c of inc.changes || []) if (!c.flag && (im.start == null || c.ts >= im.start - 24 * 3600000)) timeline.push({ at: c.ts, text: 'Change: ' + c.type + ' ' + (c.service || '') + (c.version ? ' ' + c.version : '') + ' \u2013 ' + c.desc });
    for (const a of (an && an.detect.anomalies) || []) timeline.push({ at: a.at, text: 'Detected: ' + a.title.toLowerCase() + ' \u2013 ' + a.detail });
    if (inc.opened) timeline.push({ at: Date.parse(inc.opened), text: 'Incident opened (' + inc.sev + ').' });
    for (const n of inc.notes || []) timeline.push({ at: Date.parse(n.at), text: (n.kind === 'sim' ? 'Simulated action: ' : 'Note: ') + n.text });
    timeline.sort((a, b) => (a.at || 0) - (b.at || 0));
    const evidence = top ? top.causeEvidence.slice(0, 4).map((id) => { const e = byId.get(id); return e ? 'L' + id + ' (' + (e.source || '') + ':' + e.n + '): ' + e.msg.slice(0, 160) : 'L' + id; }) : [];
    const actions = [];
    if (top) { top.fixes.forEach((f, i) => { if (/never|do not|last resort/i.test(f.title + f.why)) return; actions.push({ text: f.title, owner: i === 0 ? inc.owner || 'owner' : 'owning team', due: plusDays(t, i === 0 ? 2 : 14), kind: i === 0 ? 'mitigate' : 'prevent' }); }); }
    else for (const c of (an && an.abstain ? an.abstain.collect : []).slice(0, 3)) actions.push({ text: 'Collect: ' + c, owner: inc.owner || 'owner', due: plusDays(t, 1), kind: 'investigate' });
    actions.push({ text: 'Add an alert for the earliest signal seen in this incident' + (top ? ' (' + top.title.toLowerCase() + ')' : ''), owner: 'SRE', due: plusDays(t, 14), kind: 'detect' });
    actions.push({ text: 'Review this postmortem in the weekly incident review', owner: inc.commander || 'incident commander', due: plusDays(t, 7), kind: 'process' });
    return {
      title: 'Postmortem: ' + inc.id + ' ' + inc.title, status: 'Draft', blameless: true,
      summary: top ? inc.title + '. ' + top.summary + ' ' + (im.minutes ? 'Errors lasted about ' + im.minutes + ' minutes in the logs reviewed.' : '') : inc.title + '. The root cause is not yet determined; the logs reviewed were not enough to name one.',
      impact: [im.failRate != null ? im.failRate + '% of ' + im.requests + ' requests in the logs failed (HTTP 5xx) after ' + utc(im.start) + '.' : null, im.errors + ' error lines' + (im.services.length ? ' across ' + im.services.join(', ') : '') + '.', im.minutes ? 'Duration in the logs: about ' + im.minutes + ' minutes.' : null].filter(Boolean).join(' '),
      timeline: timeline.map((x) => ({ at: utc(x.at), text: x.text })),
      rootCause: top ? top.summary + (top.correlated ? ' It lines up with a recent change (' + top.correlated.why + ').' : '') + (evidence.length ? '\n\nEvidence:\n' + evidence.map((e) => '- ' + e).join('\n') : '') : 'Not yet determined. Data to collect:\n' + ((an && an.abstain && an.abstain.collect) || []).map((c) => '- ' + c).join('\n'),
      contributing: (an ? an.contributing.map((c) => c.text) : []).concat(top && top.symptomCount ? ['Symptoms (' + top.signals.filter((s) => s.role === 'symptom' && s.count).map((s) => s.label.toLowerCase()).join(', ') + ') made the impact visible before the cause was clear.'] : []).concat(['No alert caught the earliest signal before customers were affected.']),
      actionItems: actions,
      lessons: 'What went well: \nWhat was hard: \nWhere we got lucky: '
    };
  }
  function postmortemMd(pm) {
    return ['# ' + pm.title, '', '_' + pm.status + ' \u00b7 blameless: this document describes systems and decisions, not individual fault._', '', '## Summary', '', pm.summary, '', '## Impact', '', pm.impact, '', '## Timeline (UTC)', '', ...pm.timeline.map((x) => '- **' + x.at + '** \u2013 ' + x.text), '', '## Root cause', '', pm.rootCause, '', '## Contributing factors', '', ...pm.contributing.map((c) => '- ' + c), '', '## Action items', '', '| Action | Owner | Due | Type |', '|---|---|---|---|', ...pm.actionItems.map((a) => '| ' + String(a.text).replace(/\|/g, '\\|') + ' | ' + a.owner + ' | ' + a.due + ' | ' + a.kind + ' |'), '', '## Lessons', '', pm.lessons, ''].join('\n');
  }
  function clustersCsv(res, an) {
    const top = an && an.top; const cause = new Set(top ? top.clusters : []); const symp = new Set(top ? top.symptomClusters : []); const fresh = new Set(((an && an.detect.anomalies) || []).filter((a) => a.kind === 'new-signature').map((a) => a.cluster));
    const rows = [['cluster', 'count', 'level', 'template', 'services', 'first_utc', 'last_utc', 'role', 'new_signature', 'flagged_lines', 'example_lines']];
    for (const c of res.clusters) rows.push([c.id, c.count, c.level, c.template, Object.keys(c.services).join(' '), c.first ? new Date(c.first).toISOString() : '', c.last ? new Date(c.last).toISOString() : '', cause.has(c.id) ? 'cause' : symp.has(c.id) ? 'symptom' : '', fresh.has(c.id) ? 'yes' : '', c.flagged, c.sample.map((x) => 'L' + x).join(' ')]);
    return rows.map((r) => r.map(csvCell).join(',')).join('\n');
  }
  function reportMd(inc, res, an) {
    const top = an.top; const byId = an.byId; const line = (id) => { const e = byId.get(id); return e ? '- `L' + id + '` ' + (e.source || '') + ':' + e.n + ' ' + hm(e.ts) + ' UTC ' + (e.level || '').toUpperCase() + ' ' + (e.service || '') + ': ' + e.msg.slice(0, 200).replace(/`/g, "'") : '- `L' + id + '`'; };
    const out = ['# ' + inc.id + ': ' + inc.title, '', '- Severity: ' + inc.sev + ' \u00b7 Status: ' + statusLabel(inc.status) + ' \u00b7 Owner: ' + (inc.owner || 'unassigned'), '- Logs: ' + res.stats.entries + ' entries from ' + res.stats.sources.map((s) => s.name + ' (' + s.fmt + ')').join(', ') + ', ' + utc(res.stats.first) + ' to ' + utc(res.stats.last), '- Redacted before analysis: ' + (res.redactions.summary.map((r) => r.count + ' ' + r.label.toLowerCase()).join(', ') || 'nothing found'), '- Flagged as prompt injection and excluded: ' + res.flagged.length + ' line(s)', ''];
    if (top) { out.push('## Most likely cause: ' + top.title + ' (' + Math.round(top.confidence * 100) + '%)', '', top.summary, '', top.explanation, '', '### Cause evidence', '', ...top.causeEvidence.map(line), ''); if (top.symptomEvidence.length) out.push('### Symptom evidence', '', ...top.symptomEvidence.map(line), ''); }
    else out.push('## No root cause named', '', an.abstain.reason, '', '### Collect next', '', ...an.abstain.collect.map((c) => '- ' + c), '');
    if (an.hypotheses.length > (top ? 1 : 0)) out.push('## Other hypotheses', '', ...an.hypotheses.slice(top ? 1 : 0).map((h) => '- ' + h.title + ' \u2013 ' + Math.round(h.confidence * 100) + '% (' + h.causeCount + ' cause lines)'), '');
    out.push('## Anomalies', '', ...(an.detect.anomalies.length ? an.detect.anomalies.map((a) => '- ' + hm(a.at) + ' UTC ' + a.title + ' (' + a.role + '): ' + a.detail) : ['- none detected']), '');
    if (top) { out.push('## Suggested fixes (copy-only; nothing was run)', ''); for (const f of top.fixes) { out.push('### ' + f.title, '', f.why, '', ...f.steps.map((s, i) => (i + 1) + '. ' + s)); if (f.commands.length) out.push('', '```sh', ...f.commands.map((c) => (c.risk.level === 'risky' ? '# RISKY: ' + c.risk.reasons.map((r) => r.blast).join(' ') + '\n' : c.risk.level === 'change' ? '# changes a running system\n' : '') + c.cmd), '```'); out.push(''); } }
    if (an.past.length) out.push('## Seen before', '', ...an.past.map((p) => '- ' + p.id + ' ' + p.title + ' (' + p.date + '): ' + p.rootCause), '');
    return out.join('\n');
  }
  /* Backup: incidents, notes, drafts, library. Never settings or keys. */
  function backupJson(state) { const s = JSON.parse(JSON.stringify(state)); delete s.settings; delete s.keys; return G.redactKeys(JSON.stringify({ app: 'incidentlens-ai', version: 1, exported: new Date().toISOString(), state: s }, null, 1)); }
  function parseBackup(text) { let j; try { j = JSON.parse(text); } catch (e) { throw new Error('That file is not JSON.'); } if (!j || j.app !== 'incidentlens-ai' || !j.state || !Array.isArray(j.state.incidents)) throw new Error('That is not an IncidentLens backup.'); for (const i of j.state.incidents) if (!i.res || !Array.isArray(i.res.entries)) throw new Error('The backup is missing parsed logs for ' + (i.id || 'an incident') + '.'); return j.state; }
  return { STATUSES, SEVS, statusLabel, impact, statusDrafts, postmortem, postmortemMd, blameLint, clustersCsv, reportMd, backupJson, parseBackup, csvCell, utc, hm };
});
