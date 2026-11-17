const test = require('node:test'); const assert = require('node:assert');
const R = require('../js/redact.js'); const G = require('../js/guard.js');
const red = (s, o) => R.line(s, o);
test('secrets and personal data are replaced and reported with a type', () => {
  const cases = [
    ['Authorization: Bearer 9f8e7d6c5b4a39281706abcdefXYZ', 'bearer'],
    ['token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXRlc3Q', 'jwt'],
    ['jdbc:postgresql://orders:Sup3rS3cret@db.example:5432/orders', 'url-cred'],
    ['AWS key AKIAIOSFODNN7EXAMPLE in env', 'aws-key'],
    ['password=hunter2-not-real', 'secret'],
    ['contact ana@brightcart.example now', 'email'],
    ['card 4242 4242 4242 4242 declined', 'card'],
    ['ssn 123-45-6789', 'ssn']
  ];
  for (const [s, type] of cases) { const r = red(s); assert.ok(r.hits.some((h) => h.type === type), s + ' -> ' + JSON.stringify(r.hits)); assert.match(r.text, /\[REDACTED:/, s); }
  const k = red('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'); assert.ok(k.hits.length >= 1);
});
test('no false positives on timestamps, trace IDs, versions, UUIDs, durations and ports', () => {
  for (const s of ['2026-11-12T14:06:10.120Z ERROR', 'trace_id=4bf92f3577b34da6a3ce929d0e0e4736 span=00f067aa0ba902b7', 'release v2.41.0 (previous v2.40.3)', 'order 3f2b1c9e-8a7d-4e3f-9b1a-2c3d4e5f6a7b', 'took 30000ms on port 5432', 'HikariPool-1 - Pool stats (total=10, active=6, idle=1, waiting=3)', 'pod checkout-api-5b7d9c4f8d-w7c4n', 'GET /api/products/9053 404 112', 'build 20261112.4 sha a1b2c3d']) {
    const r = red(s); assert.strictEqual(r.hits.length, 0, s + ' -> ' + JSON.stringify(r.hits)); assert.strictEqual(r.text, s);
  }
});
test('Luhn check: a random 16-digit order number is not a card', () => { assert.strictEqual(red('order 1234567812345678').hits.length, 0); });
test('IP addresses are kept unless IP redaction is on', () => {
  assert.strictEqual(red('from 198.51.100.23').hits.length, 0);
  const r = red('from 198.51.100.23', { ip: true }); assert.strictEqual(r.hits[0].type, 'ip'); assert.ok(!r.text.includes('198.51.100.23'));
});
test('the summary counts each type', () => { const r = R.text('a@b.example c@d.example password=x1y2z3'); const s = R.summary(r.hits); assert.strictEqual(s.find((x) => x.type === 'email').count, 2); });
test('assertNoSecrets refuses a prompt that contains a key', () => {
  assert.throws(() => G.assertNoSecrets('hello test-key-not-real-123', ['test-key-not-real-123']));
  assert.doesNotThrow(() => G.assertNoSecrets('hello', ['test-key-not-real-123']));
});
