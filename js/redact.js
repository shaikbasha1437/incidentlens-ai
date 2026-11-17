/* IncidentLens redaction: secrets and personal data are masked line by line as logs are read, before anything is
   stored, shown, exported or sent to a model. Each hit is reported by type with a harmless hint (a key prefix,
   the last four card digits, an email domain) so you can see what was removed without seeing the secret. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.IL = root.IL || {}).redact = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TYPES = { 'private-key': 'Private key block', jwt: 'JSON web token', bearer: 'Bearer/Basic credential', 'aws-key': 'Cloud access key ID', 'api-key': 'API key or token', secret: 'Password or secret value', 'url-cred': 'Password in a URL', email: 'Email address', card: 'Card number', ssn: 'Social security number', ip: 'IP address' };
  function luhn(d) { let sum = 0; let alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; }
  const tag = (t) => '[REDACTED:' + t + ']';
  const SECRET_KEYS = '(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?(?:id|token)|token|private[_-]?key|aws_secret_access_key|db_pass(?:word)?|signing[_-]?key)';
  /* Order matters: big structured secrets first so smaller rules don't split them. */
  const RULES = [
    { type: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, hint: () => 'key block' },
    { type: 'url-cred', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, keep: (m, a, b, c) => a + tag('password') + c, hint: () => 'in a connection URL' },
    { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, hint: () => 'eyJ\u2026' },
    { type: 'bearer', re: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/g, keep: (m, a) => a + ' ' + tag('token'), hint: (m, a) => a + ' \u2026' },
    { type: 'aws-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, hint: (m) => m.slice(0, 4) + '\u2026' },
    { type: 'api-key', re: /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|rk_(?:live|test)_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,})\b/g, hint: (m) => m.slice(0, m.startsWith('github_pat_') ? 11 : m.indexOf('-') > 0 && m.indexOf('-') < 5 ? m.indexOf('-') + 1 : m.indexOf('_') > 0 && m.indexOf('_') < 5 ? m.indexOf('_') + 1 : 4) + '\u2026' },
    { type: 'secret', re: new RegExp('(["\']?\\b' + SECRET_KEYS + '\\b["\']?\\s*(?:=|:|=>)\\s*["\']?)(?!\\[REDACTED)([^\\s"\'&,;}\\]]{3,})', 'gi'), keep: (m, a) => a + tag('secret'), hint: (m, a) => 'value of ' + a.replace(/["'\s=:>]/g, '') },
    { type: 'email', re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, hint: (m, d) => 'at ' + d },
    { type: 'card', re: /\b(?:\d{4}[ -]){3}\d{1,7}\b|\b[3-6]\d{12,18}\b/g, test: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && /^[3-6]/.test(d) && luhn(d); }, hint: (m) => 'ending ' + m.replace(/\D/g, '').slice(-4) },
    { type: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, test: (m, line, idx) => !/\d{4}-$/.test(line.slice(Math.max(0, idx - 5), idx)), hint: () => '***-**-' },
    { type: 'ip', optional: true, re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, test: (m, line, idx) => !/[\w.]$/.test(line.slice(Math.max(0, idx - 1), idx)) || /[\s"'(\[=,:]$/.test(line.slice(Math.max(0, idx - 1), idx)), hint: (m) => (m.includes(':') ? 'IPv6' : 'IPv4 ' + m.split('.')[0] + '.x.x.x') }
  ];
  /* Redact one line (or a multi-line entry). opts.ip: also mask IP addresses. Returns { text, hits:[{type, hint}] }. */
  function line(s, opts) {
    const o = opts || {}; let text = String(s == null ? '' : s); const hits = [];
    if (!/[@=:.\d-]|Bearer|Basic|Token|eyJ|AKIA|ASIA|sk-|AIza|gh[pousr]_|xox|BEGIN/.test(text)) return { text, hits };
    for (const r of RULES) {
      if (r.optional && !o.ip) continue;
      r.re.lastIndex = 0;
      text = text.replace(r.re, function (m) {
        const args = Array.prototype.slice.call(arguments); const idx = args[args.length - 2]; const whole = args[args.length - 1];
        if (/^\[REDACTED/.test(m)) return m;
        if (r.test && !r.test(m, whole, idx)) return m;
        hits.push({ type: r.type, hint: r.hint ? r.hint.apply(null, args) : '' });
        return r.keep ? r.keep.apply(null, args) : tag(r.type);
      });
    }
    return { text, hits };
  }
  /* Whole text, line by line, with 1-based line numbers on each hit. */
  function text(s, opts) {
    const lines = String(s || '').split(/\r?\n/); const hits = []; const out = lines.map((l, i) => { const r = line(l, opts); r.hits.forEach((h) => hits.push(Object.assign({ line: i + 1 }, h))); return r.text; });
    return { text: out.join('\n'), hits };
  }
  function summary(hits) { const by = {}; for (const h of hits || []) by[h.type] = (by[h.type] || 0) + 1; return Object.entries(by).map(([type, count]) => ({ type, label: TYPES[type] || type, count })).sort((a, b) => b.count - a.count); }
  return { TYPES, RULES, line, text, summary, luhn };
});
