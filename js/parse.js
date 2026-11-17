/* IncidentLens log parser: one line at a time, so it can stream through large files in a Web Worker.
   Understands JSON lines, logfmt, nginx/Apache access logs, syslog (RFC 3164 and 5424), Kubernetes events and
   pod logs, Spring Boot / Python / Go style prefixed lines, Datadog and CloudWatch CSV or JSON exports, and joins
   Python, Java and Node stack traces onto the line that threw. Every entry gets a UTC timestamp (ms), a level,
   a service and a message. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.IL = root.IL || {}).parse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
  function normLevel(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v >= 60 ? 'fatal' : v >= 50 ? 'error' : v >= 40 ? 'warn' : v >= 30 ? 'info' : v >= 20 ? 'debug' : 'trace'; // pino/bunyan numbers
    const s = String(v).trim().toLowerCase();
    if (/^(trace|verbose|finest|finer)$/.test(s)) return 'trace';
    if (/^(debug|dbg|fine|d)$/.test(s)) return 'debug';
    if (/^(info|information|informational|notice|normal|i|ok|success)$/.test(s)) return 'info';
    if (/^(warn|warning|w|wrn)$/.test(s)) return 'warn';
    if (/^(error|err|e|severe|failure|failed|fail)$/.test(s)) return 'error';
    if (/^(fatal|critical|crit|panic|emerg|emergency|alert|f)$/.test(s)) return 'fatal';
    if (/^[0-7]$/.test(s)) return ['fatal', 'fatal', 'fatal', 'error', 'warn', 'info', 'info', 'debug'][+s]; // syslog severities
    return null;
  }
  /* Parse a timestamp string to UTC ms. Times without a zone are read as UTC. opts.year fills in syslog dates. */
  function parseTs(v, opts) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d{10}(\.\d+)?$|^\d{13}$/.test(String(v).trim())) { const n = +v; return n > 1e12 ? Math.round(n) : Math.round(n * 1000); }
    const s = String(v).trim(); let m;
    if ((m = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?/i.exec(s))) {
      let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0);
      if (m[8] && /^[+-]/.test(m[8])) { const z = m[8].replace(':', ''); const off = (+z.slice(1, 3) * 60 + +z.slice(3, 5)) * (z[0] === '-' ? -1 : 1); t -= off * 60000; }
      return t;
    }
    if ((m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s*([+-]\d{4}))?/.exec(s))) {
      let t = Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1], +m[4], +m[5], +m[6]);
      if (m[7]) { const off = (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * (m[7][0] === '-' ? -1 : 1); t -= off * 60000; }
      return t;
    }
    if ((m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(s)) && MON[m[1].toLowerCase()] != null) {
      const y = (opts && opts.year) || new Date().getUTCFullYear();
      return Date.UTC(y, MON[m[1].toLowerCase()], +m[2], +m[3], +m[4], +m[5], m[6] ? Math.round(+('0.' + m[6]) * 1000) : 0);
    }
    if ((m = /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?$/.exec(s)) && opts && opts.day != null) return opts.day + ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + (m[4] ? Math.round(+('0.' + m[4]) * 1000) : 0);
    const d = Date.parse(s); return isNaN(d) ? null : d;
  }
  function get(o, paths) { for (const p of paths) { let v = o; for (const k of p.split('.')) { if (v == null) break; v = Object.prototype.hasOwnProperty.call(v, k) ? v[k] : v[p] !== undefined && k === p.split('.')[0] ? v[p] : undefined; } if (v == null && o && o[p] != null) v = o[p]; if (v != null && v !== '') return v; } return null; }
  const TS_KEYS = ['@timestamp', 'timestamp', 'time', 'ts', 'date', 'datetime', 'eventTime', 'event_time', 'Date', 'Timestamp', 't', 'asctime'];
  const LVL_KEYS = ['level', 'severity', 'lvl', 'log.level', 'levelname', 'loglevel', 'status', 'Status', 'severity_text', 'type'];
  const SVC_KEYS = ['service', 'service.name', 'svc', 'app', 'application', 'component', 'logger', 'logger_name', 'kubernetes.container_name', 'container', 'source', 'Service', 'program', 'name'];
  const MSG_KEYS = ['message', 'msg', 'log', 'event', 'error.message', 'Message', 'text', 'body', 'textPayload'];
  const HTTP_KEYS = ['status', 'status_code', 'statusCode', 'http.status_code', 'http_status', 'response.status', 'res.statusCode'];
  const LAT_KEYS = ['duration_ms', 'latency_ms', 'elapsed_ms', 'response_time_ms', 'responseTime', 'took_ms', 'duration', 'latency', 'request_time', 'rt'];
  function latencyMs(k, v) { const n = parseFloat(v); if (isNaN(n)) return null; if (/_ms$|Ms$|took|responseTime/.test(k)) return n; if (/request_time|^rt$/.test(k)) return n * 1000; if (typeof v === 'string' && /ms$/.test(v)) return n; if (typeof v === 'string' && /s$/.test(v)) return n * 1000; return n < 60 && String(v).includes('.') ? n * 1000 : n; }
  function fromObject(o, line, opts) {
    const e = { fmt: 'json' };
    e.ts = parseTs(get(o, TS_KEYS), opts);
    let lv = get(o, LVL_KEYS); if (typeof lv === 'string' && /^\d{3}$/.test(lv)) lv = null;
    e.level = normLevel(lv);
    e.service = get(o, SVC_KEYS); if (e.service && typeof e.service !== 'string') e.service = null;
    let msg = get(o, MSG_KEYS); if (msg && typeof msg === 'object') msg = JSON.stringify(msg);
    const err = get(o, ['error.stack', 'stack', 'stack_trace', 'exception', 'err.stack', 'error.stack_trace']);
    const errMsg = get(o, ['error.message', 'err.message', 'error']);
    if (!msg) msg = typeof errMsg === 'string' ? errMsg : line;
    if (typeof errMsg === 'string' && msg.indexOf(errMsg) < 0) msg += ': ' + errMsg;
    e.msg = String(msg);
    if (typeof err === 'string' && err.includes('\n')) e.trace = err.split('\n').map((x) => x.replace(/\s+$/, '')).filter(Boolean).filter((x, i) => !(i === 0 && e.msg.includes(x.trim())));
    const st = get(o, HTTP_KEYS); const method = get(o, ['method', 'http.method', 'request.method', 'req.method']); const path = get(o, ['path', 'url', 'http.url', 'request.path', 'uri', 'req.url', 'route']);
    if (st != null && /^\d{3}$/.test(String(st))) { e.http = { status: +st, method: method || null, path: path || null }; for (const k of LAT_KEYS) { const v = get(o, [k]); if (v != null) { e.http.ms = latencyMs(k, v); break; } } if (!e.level) e.level = e.http.status >= 500 ? 'error' : e.http.status >= 400 ? 'warn' : 'info';  if (e.http.method && e.http.path && e.msg.indexOf(String(e.http.status)) < 0) e.msg = (e.msg && e.msg !== line ? e.msg + ': ' : '') + e.http.method + ' ' + e.http.path + ' ' + e.http.status; }
    if (!e.level && typeof lv === 'string' && /^(warning|normal)$/i.test(lv)) e.level = lv.toLowerCase() === 'warning' ? 'warn' : 'info';
    if (o.reason && o.involvedObject) { e.k8s = { reason: o.reason, object: (o.involvedObject.kind || '').toLowerCase() + '/' + (o.involvedObject.name || '') }; e.fmt = 'k8s-event'; }
    return e;
  }
  /* logfmt: key=value pairs with optional quotes. */
  function logfmt(line) { const o = {}; const re = /([\w.@-]+)=("((?:[^"\\]|\\.)*)"|\S*)/g; let m; let n = 0; while ((m = re.exec(line))) { o[m[1]] = m[3] != null ? m[3].replace(/\\"/g, '"') : m[2]; n++; } return n >= 2 ? o : null; }
  function splitCsv(line) { const out = []; let cur = ''; let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; }
  const ACCESS = /^(\S+) \S+ (\S+) \[([^\]]+)\] "(\S+) (\S+)(?: [^"]*)?" (\d{3}) (\d+|-)(?: "([^"]*)" "((?:[^"\\]|\\.)*)")?(.*)$/;
  const SYSLOG = /^(?:<(\d{1,3})>)?([A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) (\S+) ([\w./@-]+?)(?:\[(\d+)\])?: ?(.*)$/;
  const SYSLOG5424 = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[.*?\]) ?(.*)$/;
  const K8S_EVENT = /^(?:(\S+)\s+)?(Normal|Warning)\s+([A-Z][A-Za-z]+)\s+((?:pod|deployment|replicaset|node|service|job|statefulset|daemonset|horizontalpodautoscaler|persistentvolumeclaim|ingress|cronjob)\/\S+)\s+(.*)$/i;
  const PREFIX_TS = /^\[?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?\s*(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})?)\]?\s*(.*)$/i;
  const LEVEL_WORD = /^(?:\[|<)?(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|CRIT(?:ICAL)?|FATAL|PANIC|SEVERE|EMERG|ALERT|[DIWEF](?=\s))(?:\]|>)?\s*[:|-]?\s*/i;
  const POD_PREFIX = /^\[?(?:pod\/)?([a-z0-9][a-z0-9-]*?)(?:-[a-z0-9]{8,10})?(?:-[a-z0-9]{5})?(?:\/([a-z0-9-]+))?\]\s+(.*)$/;
  function levelFromText(s) {
    const m = /\b(FATAL|PANIC|CRITICAL|ERROR|SEVERE|WARN(?:ING)?|Traceback|Exception|OOMKilled)\b/.exec(s);
    if (m) { const w = m[1].toUpperCase(); return w === 'FATAL' || w === 'PANIC' || w === 'CRITICAL' ? 'fatal' : w === 'WARN' || w === 'WARNING' ? 'warn' : 'error'; }
    // No level word: guess from what the line says.
    if (/\b(failed|failure|expired|refused|timed out|exception|panic|unable to|cannot|could not|denied|unreachable|no such host|out of memory|segfault|crash(?:ed)?|fatal)\b/i.test(s)) return 'error';
    if (/\b(retry(?:ing)?|slow|deprecated|degraded|throttl\w*|backoff|back-off|high latency)\b/i.test(s)) return 'warn';
    return null;
  }
  /* Continuation lines that belong to the previous entry (stack frames and exception chains). */
  function isContinuation(line, prev) {
    if (!prev) return false;
    if (/^\s+at\s+\S|^\s*at [\w$.<>]+\s*\(|^\s+File "|^\s+\.\.\. \d+ more|^\s*Caused by: |^Traceback \(most recent call last\):|^\s+\^+\s*$|^\s{2,}\S.*\.(?:js|ts|py|java|go|rb):\d+|^goroutine \d+ \[|^\t\/\S+\.go:\d+|^\s{4,}\S/.test(line)) return true;
    if (prev.inTrace && /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)|[\w.]+\.[A-Z]\w+)(?::\s.*)?$/.test(line)) return true;
    if (/^[a-z][\w$]*(?:\.[\w$]+)+\.[A-Z][\w$]*(?:Exception|Error)(?::\s.*)?$/.test(line) && (prev.level === 'warn' || prev.level === 'error' || prev.level === 'fatal')) return true;
    if (prev.inTrace && /^During handling of the above exception|^The above exception was the direct cause/.test(line)) return true;
    return false;
  }
  function accessEntry(m, opts) {
    const st = +m[6]; const extra = m[10] || ''; let ms = null; const rt = /(?:\brt|request_time|upstream_response_time|urt|rtime)=([\d.]+)/.exec(extra) || /\s([\d]+\.\d{3})\s*$/.exec(extra) || /\s(\d+)ms\b/.exec(extra);
    if (rt) ms = /ms\b/.test(rt[0]) ? +rt[1] : +rt[1] * 1000;
    const up = /upstream(?:_name)?="?([\w.-]+)/.exec(extra);
    return { fmt: 'access', ts: parseTs(m[3], opts), level: st >= 500 ? 'error' : st >= 400 ? 'warn' : 'info', service: (up && !/^\d/.test(up[1]) ? up[1] : null) || opts.service || 'access-log', msg: m[4] + ' ' + m[5] + ' ' + st, http: { status: st, method: m[4], path: m[5], ms, ua: m[9] || '', client: m[1] } };
  }
  /* Parse one (already redacted) physical line into an entry, or null when it is blank. */
  function parseLine(line, opts, csv) {
    const o = opts || {}; const s = line.replace(/\s+$/, ''); if (!s.trim()) return null;
    let m; const t = s.trimStart();
    if (csv) { const f = splitCsv(s); const obj = {}; csv.forEach((k, i) => { if (k) obj[k] = f[i]; }); const e = fromObject(obj, s, o); e.fmt = 'csv'; const inner = e.msg && e.msg !== s ? parseLine(e.msg, Object.assign({}, o, { service: e.service || o.service }), null) : null; if (inner && inner.fmt !== 'text') { inner.ts = inner.ts || e.ts; inner.level = inner.level || e.level; inner.service = e.service || inner.service; inner.fmt = 'csv+' + inner.fmt; return inner; } if (!e.level) e.level = levelFromText(e.msg) || 'info'; return e; }
    if (t[0] === '{') { try { const obj = JSON.parse(t); if (obj && typeof obj === 'object') { const e = fromObject(obj, s, o); if (e.msg && e.msg !== s && !e.http && !e.k8s) { const inner = parseLine(e.msg, Object.assign({}, o, { service: e.service || o.service }), null); if (inner && (inner.http || /^(access|syslog|k8s-event)$/.test(inner.fmt))) { inner.ts = inner.ts || e.ts; inner.level = inner.level || e.level; inner.service = e.service || inner.service; inner.fmt = 'json+' + inner.fmt; return inner; } if (inner && !e.ts) e.ts = inner.ts; if (inner && !e.level) e.level = inner.level; } if (!e.level) e.level = levelFromText(e.msg) || 'info'; if (!e.service) e.service = o.service || null; return e; } } catch (er) { /* not JSON */ } }
    if ((m = ACCESS.exec(t))) return accessEntry(m, o);
    if ((m = SYSLOG5424.exec(t))) { const pri = +m[1]; const msg = m[8]; return { fmt: 'syslog', ts: parseTs(m[2], o), level: normLevel(String(pri % 8)) === 'info' ? (levelFromText(msg) || 'info') : normLevel(String(pri % 8)), service: m[4] !== '-' ? m[4] : o.service || null, host: m[3], msg }; }
    if ((m = SYSLOG.exec(t))) { let msg = m[6]; let level = m[1] != null ? normLevel(String(+m[1] % 8)) : null; const lw = LEVEL_WORD.exec(msg); if (lw && lw[1].length > 1) { level = normLevel(lw[1]); msg = msg.slice(lw[0].length); } if (!level || level === 'info') level = levelFromText(msg) || level || 'info'; return { fmt: 'syslog', ts: parseTs(m[2], o), level, service: m[4], host: m[3], msg }; }
    if ((m = K8S_EVENT.exec(t))) { const reason = m[3]; const bad = /OOM|BackOff|Failed|Unhealthy|Evicted|Killing|FailedScheduling|CrashLoop|NodeNotReady|FailedMount/i.test(reason) || /OOMKilled|CrashLoopBackOff|exit code 137/i.test(m[5]); const ts = m[1] && /\d{4}-\d{2}-\d{2}/.test(m[1]) ? parseTs(m[1], o) : m[1] && /^\d+[smhd]$/.test(m[1]) && o.now ? o.now - ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[1].slice(-1)] * parseInt(m[1], 10)) : null; const obj = m[4]; return { fmt: 'k8s-event', ts, approxTs: !!(m[1] && !/\d{4}-/.test(m[1])), level: /OOM/i.test(reason + m[5]) ? 'error' : m[2].toLowerCase() === 'warning' ? (bad && /BackOff|Failed|Evicted/i.test(reason) ? 'error' : 'warn') : 'info', service: obj.split('/')[1].replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$|-[a-z0-9]{5}$/, ''), msg: reason + ' ' + obj + ': ' + m[5], k8s: { reason, object: obj } }; }
    if (/^\s*[A-Za-z]+=/.test(t) && /\b(level|lvl|msg|message)=/.test(t)) { const obj = logfmt(t); if (obj) { const e = fromObject(obj, s, o); e.fmt = 'logfmt'; if (!e.level) e.level = levelFromText(e.msg) || 'info'; if (!e.service) e.service = o.service || null; return e; } }
    let rest = t; let ts = null; let service = o.service || null; let fmt = 'text'; let pod = null;
    if ((m = POD_PREFIX.exec(rest)) && /^\[/.test(rest)) { pod = m[1]; service = m[2] && m[2] !== m[1] ? m[1] : m[1]; rest = m[3]; fmt = 'k8s-pod'; }
    if ((m = PREFIX_TS.exec(rest))) { ts = parseTs(m[1], o); rest = m[2]; fmt = fmt === 'text' ? 'prefixed' : fmt; }
    else if ((m = /^([A-Z][a-z]{2} \d{1,2},? \d{4},? \d{1,2}:\d{2}:\d{2}(?: [AP]M)?)\s+(.*)$/.exec(rest))) { ts = parseTs(m[1], o); rest = m[2]; fmt = 'prefixed'; }
    else if ((m = /^(\d{10}(?:\.\d+)?|\d{13})\s+(.*)$/.exec(rest))) { ts = parseTs(m[1], o); rest = m[2]; fmt = 'prefixed'; }
    let level = null; const lw = LEVEL_WORD.exec(rest);
    if (lw && (lw[1].length > 1 || ts)) { level = normLevel(lw[1]); rest = rest.slice(lw[0].length); }
    // Spring Boot: "  WARN 1 --- [nio-8080-exec-3] c.z.h.p.HikariPool : message"
    if ((m = /^(\d+)\s+---\s+\[\s*([^\]]+)\]\s+(\S+)\s+:\s+(.*)$/.exec(rest))) { rest = m[4]; service = service || o.service || m[3].split('.').pop(); }
    // "[service]" or "service:" right after the level.
    if ((m = /^\[([A-Za-z][\w.-]{1,40})\]\s*:?\s+(.*)$/.exec(rest)) && !/^(main|info|error|warn)$/i.test(m[1])) { if (!o.service || fmt === 'k8s-pod') service = service && fmt === 'k8s-pod' ? service : m[1]; rest = m[2]; }
    else if (ts && level && (m = /^([a-z][\w-]*(?:\.[\w-]+)*):\s+(.*)$/.exec(rest)) && m[1].length < 40) { service = service || m[1]; rest = m[2]; }
    if (!level && (m = /\blevel=(\w+)/i.exec(rest))) level = normLevel(m[1]);
    if (!level) level = levelFromText(rest) || (fmt === 'text' && /^(Exception in thread|panic:|FATAL ERROR:|Error:|[A-Z]\w*(?:Error|Exception)\b)/.test(rest) ? 'error' : 'info');
    const e = { fmt, ts, level, service, msg: rest };
    if (pod) e.pod = pod;
    if ((m = /\b(?:status|code)[=: ](\d{3})\b/.exec(rest)) && /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\b/.test(rest)) { e.http = { status: +m[1] }; const lm = /\b(?:duration|latency|took|elapsed|rt)[=: ]([\d.]+)\s*(ms|s)?\b/.exec(rest); if (lm) e.http.ms = lm[2] === 's' ? +lm[1] * 1000 : +lm[1]; }
    return e;
  }
  /* Header row of a CSV export (Datadog, CloudWatch Logs Insights, generic). Returns lower-cased column keys or null. */
  function csvHeader(line) {
    if (!/,/.test(line) || /^\s*[{[]/.test(line)) return null;
    const cols = splitCsv(line).map((c) => c.trim().replace(/^@/, '').toLowerCase());
    const has = (re) => cols.some((c) => re.test(c));
    if (cols.length >= 2 && has(/^(date|timestamp|time|datetime|ts|@timestamp)$/) && has(/^(message|msg|log|content|textpayload)$/)) return cols.map((c) => ({ date: 'date', datetime: 'date', host: 'host', status: 'status', content: 'message', textpayload: 'message' }[c] || c));
    return null;
  }
  /* Streaming parser. push(text) any size chunk; end() flushes. onEntry(entry) gets each finished entry. */
  function createParser(opts, onEntry) {
    const o = Object.assign({}, opts || {}); let buf = ''; let lineNo = 0; let cur = null; let csv = null; let first = true; let gotEnd = false;
    const pre = o.preprocess || ((l) => ({ text: l, hits: [] }));
    function finish() { if (cur) { const e = cur; cur = null; delete e.inTrace; onEntry(e); } }
    function handle(raw) {
      lineNo++;
      const r = pre(raw, lineNo); const line = r.text;
      if (first && line.trim()) { first = false; const h = csvHeader(line); if (h) { csv = h; return; } }
      if (cur && isContinuation(line, cur)) { cur.trace = cur.trace || []; cur.trace.push(line.replace(/\s+$/, '')); cur.raw += '\n' + line; cur.inTrace = true; cur.lines++; if (r.hits.length) cur.hits = (cur.hits || []).concat(r.hits.map((h) => Object.assign({ line: lineNo }, h))); if (/^\s*Caused by: |^([A-Za-z_][\w.]*(?:Error|Exception))(?::|$)/.test(line.trim()) && (!cur.exc || /^\s*Caused by: /.test(line))) cur.exc = line.trim().replace(/^Caused by:\s*/, ''); return; }
      const e = parseLine(line, o, csv);
      if (!e) { return; }
      finish();
      e.n = lineNo; e.raw = line; e.lines = 1; e.source = o.source || null; if (r.hits.length) e.hits = r.hits.map((h) => Object.assign({ line: lineNo }, h));
      if (/^Traceback \(most recent call last\)|^Exception in thread|^panic:|^FATAL ERROR:/.test(e.msg)) e.inTrace = true;
      if (e.trace && e.trace.length) { const last = e.trace.filter((x) => /^\s*Caused by: /.test(x)).pop(); if (last) e.exc = last.trim().replace(/^Caused by:\s*/, ''); }
      cur = e;
    }
    return {
      push(chunk) { if (gotEnd) throw new Error('parser already ended'); buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } },
      end() { gotEnd = true; if (buf.length) handle(buf.replace(/\r$/, '')); buf = ''; finish(); return { lines: lineNo, csv: !!csv }; },
      get lines() { return lineNo; }
    };
  }
  /* Whole-document JSON exports (CloudWatch {"events":[...]}, a JSON array, Kubernetes {"items":[...]}) become JSON lines. */
  function expandJsonDoc(text) {
    const t = String(text).trimStart(); if (t[0] !== '[' && !(t[0] === '{' && /^\{\s*"(events|items|logs|data|results|logEvents)"\s*:/.test(t))) return null;
    let doc; try { doc = JSON.parse(t); } catch (e) { return null; }
    const arr = Array.isArray(doc) ? doc : doc.events || doc.items || doc.logs || doc.data || doc.results || doc.logEvents;
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  }
  function parseText(text, opts) { const out = []; const p = createParser(opts, (e) => out.push(e)); p.push(expandJsonDoc(text) || String(text || '')); p.end(); return out; }
  return { LEVELS, RANK, normLevel, parseTs, parseLine, createParser, parseText, expandJsonDoc, csvHeader, splitCsv, isContinuation, logfmt };
});
