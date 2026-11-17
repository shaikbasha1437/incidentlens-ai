const test = require('node:test'); const assert = require('node:assert');
const P = require('../js/parse.js'); const PL = require('../js/pipeline.js');
const one = (line, o) => P.parseText(line, Object.assign({ year: 2026 }, o || {}))[0];
test('JSON lines: time, level, service and HTTP status', () => {
  const e = one('{"time":"2026-11-12T14:06:10.120Z","level":"error","service":"checkout-api","msg":"boom","method":"POST","path":"/api/checkout","status":500}');
  assert.strictEqual(e.fmt, 'json'); assert.strictEqual(e.level, 'error'); assert.strictEqual(e.service, 'checkout-api'); assert.strictEqual(e.ts, Date.parse('2026-11-12T14:06:10.120Z')); assert.strictEqual(e.http.status, 500);
});
test('nginx access log: 5xx is an error and the status is kept', () => {
  const e = one('198.51.100.23 - - [12/Nov/2026:14:12:33 +0000] "POST /api/checkout HTTP/1.1" 502 120 "-" "curl/8" rt=0.041');
  assert.strictEqual(e.fmt, 'access'); assert.strictEqual(e.level, 'error'); assert.strictEqual(e.http.status, 502); assert.strictEqual(e.ts, Date.UTC(2026, 10, 12, 14, 12, 33));
});
test('syslog (RFC 3164) uses the given year', () => {
  const e = one('Nov 17 00:00:04 pay-1 payments-svc[812]: ERROR TLS handshake failed: x509: certificate has expired');
  assert.strictEqual(e.fmt, 'syslog'); assert.strictEqual(e.level, 'error'); assert.strictEqual(e.service, 'payments-svc'); assert.strictEqual(new Date(e.ts).getUTCFullYear(), 2026);
});
test('Kubernetes events: OOMKilled and BackOff are warnings or errors', () => {
  const out = P.parseText('LAST SEEN   TYPE      REASON      OBJECT                    MESSAGE\n2m          Warning   BackOff     pod/recs-svc-7d9f-abcde   Back-off restarting failed container\n', { year: 2026 });
  const e = out.find((x) => /Back-off/.test(x.msg)); assert.ok(e); assert.ok(['warn', 'error'].includes(e.level));
});
test('Python and Java stack traces are joined onto the line that threw', () => {
  const py = P.parseText('2026-11-17 00:00:05,120 ERROR refunds-worker Refund failed\nTraceback (most recent call last):\n  File "w.py", line 3, in run\n    pay()\nssl.SSLCertVerificationError: certificate verify failed: certificate has expired\n2026-11-17 00:00:09,000 INFO refunds-worker next', { year: 2026 });
  assert.strictEqual(py.length, 2); assert.ok(py[0].trace.length >= 3); assert.match(py[0].exc || '', /SSLCertVerificationError/);
  const java = P.parseText('2026-11-12 09:49:31.120  WARN 1 --- [nio-8080-exec-3] o.h.engine.jdbc.spi.SqlExceptionHelper : SQL Error: 0, SQLState: null\njava.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available\n\tat com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)\n2026-11-12 09:49:32.000  INFO 1 --- [main] x.Y : ok', { year: 2026 });
  assert.strictEqual(java.length, 2); assert.ok(java[0].trace.length >= 2);
});
test('logfmt and plain lines get a level from keywords', () => {
  const e = one('time=2026-11-16T10:12:00Z level=warn service=web msg="slow upstream" dur=812ms'); assert.strictEqual(e.level, 'warn'); assert.strictEqual(e.service, 'web');
  const p = one('2026-11-16T10:12:00Z connection refused while dialing db:5432'); assert.strictEqual(p.level, 'error');
});
test('CSV exports (Datadog style) are read with their header', () => {
  const out = P.parseText('date,host,service,status,message\n2026-11-14T17:00:01Z,web-1,cart-svc,error,"dial tcp: lookup redis.internal: no such host"\n', { year: 2026 });
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].service, 'cart-svc'); assert.strictEqual(out[0].level, 'error');
});
test('streaming: any chunk boundary gives the same entries as one push', () => {
  const text = ['{"time":"2026-11-12T14:06:10Z","level":"error","msg":"a"}', '2026-11-12 09:49:31.120 ERROR 1 --- [x] a.B : fail', 'java.lang.IllegalStateException: bad', '\tat a.B(B.java:1)', 'Nov 17 00:00:04 h svc[1]: ERROR x', '198.51.100.2 - - [12/Nov/2026:14:12:33 +0000] "GET / HTTP/1.1" 200 1 "-" "-"'].join('\r\n') + '\n';
  const whole = []; const a = P.createParser({ year: 2026 }, (e) => whole.push(e)); a.push(text); a.end();
  for (const size of [1, 2, 3, 7, 16, 64]) { const got = []; const p = P.createParser({ year: 2026 }, (e) => got.push(e)); for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size)); p.end(); assert.deepStrictEqual(got.map((e) => [e.ts, e.level, e.msg, (e.trace || []).length]), whole.map((e) => [e.ts, e.level, e.msg, (e.trace || []).length]), 'chunk ' + size); }
});
test('pipeline: lines are redacted before they are kept, and stats add up', () => {
  const res = PL.run([{ name: 'a.log', text: '2026-11-12T14:00:00Z ERROR [api] auth failed for jo@shop.example with Authorization: Bearer abc.def.ghi123456789\n2026-11-12T14:00:01Z INFO [api] ok\n' }], { year: 2026 });
  assert.strictEqual(res.stats.entries, 2); assert.ok(!JSON.stringify(res).includes('jo@shop.example')); assert.ok(!JSON.stringify(res).includes('abc.def.ghi123456789')); assert.ok(res.redactions.total >= 2);
});
test('pipeline: huge info volume is sampled but every warning and error is kept', () => {
  const lines = []; for (let i = 0; i < 3000; i++) lines.push('2026-11-12T14:' + String(Math.floor(i / 60) % 60).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + 'Z ' + (i % 100 === 0 ? 'ERROR' : 'INFO') + ' [api] req ' + i);
  const res = PL.run([{ name: 'a.log', text: lines.join('\n') }], { year: 2026, maxKeep: 1000 });
  assert.ok(res.entries.length <= 1100); assert.strictEqual(res.entries.filter((e) => e.level === 'error').length, 30); assert.ok(res.stats.dropped > 0);
});
