/* IncidentLens known-incident library: fictional runbooks for common failure patterns. Each pattern lists log
   signals (regular expressions) marked as a cause, a symptom or context, the kinds of recent change that make it
   more likely, fixes with copy-only commands, and what to collect when the evidence is thin. The library is
   editable in the app, and you can add your own. Past incidents are fictional write-ups used for "seen before". */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.IL = root.IL || {}).patterns = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const S = (id, label, re, role, weight) => ({ id, label, re, role, weight });
  const PATTERNS = [
    {
      id: 'bad-deploy', title: 'Bad deploy or regression', category: 'Change', builtin: true,
      summary: 'A release introduced a code path that throws. New error signatures appear in the deployed service minutes after the rollout, and requests start failing.',
      cause: 'Release {version} of {service} introduced an error that did not exist before the deploy.',
      deployCorrelated: true, changeTypes: ['deploy', 'release', 'rollout'], changeKeywords: [],
      signals: [
        S('exception', 'Application exceptions (TypeError, NullPointerException, panic...)', '\\b(TypeError|ReferenceError|NullPointerException|ClassCastException|AttributeError|KeyError|IndexError|undefined is not|cannot read propert(?:y|ies) of (?:undefined|null)|nil pointer dereference|panic:|unhandled (?:exception|rejection|error))', 'cause', 2),
        S('http5xx', 'HTTP 500 responses', '^(?:GET|POST|PUT|PATCH|DELETE) \\S+ 50[0-9]$|\\bstatus[=: ]50[0-9]\\b|Internal Server Error', 'symptom', 1)
      ],
      fixes: [
        { id: 'rollback', title: 'Roll back {service} to {prev}', why: 'The fastest way to stop the bleeding when errors start right after a release. Fix forward once it is calm.', steps: ['Announce the rollback in the incident channel.', 'Roll back the deployment to the previous revision.', 'Watch the error rate and the new error signature; both should drop within a few minutes.', 'Freeze further deploys of {service} until the fix is reviewed.'], commands: [{ cmd: 'kubectl -n {ns} rollout history deployment/{service}', note: 'See revisions first' }, { cmd: 'kubectl -n {ns} rollout undo deployment/{service}', note: 'Back to the previous revision ({prev})' }, { cmd: 'kubectl -n {ns} rollout status deployment/{service} --timeout=5m', note: 'Wait for the rollout' }], simulate: 'Roll back deployment/{service} from {version} to {prev}' },
        { id: 'flag-off', title: 'Turn off the feature behind the change', why: 'If the change shipped behind a feature flag, switching it off is safer than a full rollback.', steps: ['Find the flag named in the release notes.', 'Turn it off for all users and confirm errors stop.'], commands: [{ cmd: 'flagctl set {service}.{flag} off --env production', note: 'Fictional flag CLI' }] },
        { id: 'fix-forward', title: 'Fix forward with a test for the failing path', why: 'After rollback, reproduce with the request that failed and add a regression test.', steps: ['Copy a failing request from the evidence lines.', 'Reproduce locally against {version}.', 'Add a test and ship the fix through the normal pipeline.'], commands: [{ cmd: 'git log --oneline {prev}..{version}', note: 'What changed between the two releases' }] }
      ],
      collect: ['Release notes and diff between {prev} and {version}', 'Error rate per version (canary vs stable) if you run canaries', 'A full failing request and its trace ID']
    },
    {
      id: 'db-pool-exhaustion', title: 'Database connection pool exhaustion', category: 'Database', builtin: true,
      summary: 'The service cannot get a database connection: every connection in the pool is busy or leaked, so requests wait, time out and pile up upstream.',
      cause: 'The {service} database connection pool ran out of connections, so requests waited and timed out.',
      changeTypes: ['config', 'deploy', 'traffic'], changeKeywords: ['pool', 'hikari', 'connection', 'max_connections', 'datasource', 'pgbouncer'],
      signals: [
        S('pool-timeout', 'Pool timeout / no connection available', 'connection pool (?:is )?exhausted|Connection is not available, request timed out|timeout acquiring (?:a )?connection|could not (?:obtain|get|acquire) (?:a )?(?:database )?connection|QueuePool limit|SQLTransientConnectionException|pool timeout|too many (?:clients|connections)|remaining connection slots are reserved|sorry, too many clients', 'cause', 3),
        S('pool-stats', 'Pool stats show no idle connections', '\\b(?:idle|available)[=: ]0\\b|\\bwaiting[=: ][1-9]\\d*\\b|pool stats', 'cause', 1),
        S('slow-query', 'Slow or blocked queries', 'slow query|duration: \\d{4,}(?:\\.\\d+)? ms|lock wait timeout|statement timeout|canceling statement due to', 'context', 1),
        S('tx-fail', 'Transactions cannot start', 'CannotCreateTransactionException|Could not open JPA EntityManager|unable to acquire JDBC Connection', 'symptom', 1),
        S('gateway-timeout', 'Gateway timeouts upstream', '\\b504\\b|Gateway Time-?out|upstream timed out|deadline exceeded|context deadline', 'symptom', 1)
      ],
      fixes: [
        { id: 'revert-pool', title: 'Revert the pool size change', why: 'If a config change shrank the pool just before the incident, restoring it is the quickest relief.', steps: ['Restore the previous maximum pool size.', 'Check the database can take the connections (max_connections across every replica).', 'Watch pending connections and p95 latency fall.'], commands: [{ cmd: 'kubectl -n {ns} set env deployment/{service} SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE=40', note: 'Example; use your previous value' }, { cmd: 'kubectl -n {ns} rollout status deployment/{service}', note: '' }], simulate: 'Restore the connection pool size on {service}' },
        { id: 'find-holders', title: 'Find who is holding connections', why: 'Long transactions and leaked connections keep the pool full. Look before killing anything.', steps: ['List the longest-running sessions from the service.', 'Check for idle-in-transaction sessions (a leak).', 'Only terminate a session after confirming it is stuck, and note it in the timeline.'], commands: [{ cmd: "psql -h {db} -c \"SELECT pid, state, now()-xact_start AS age, left(query,80) FROM pg_stat_activity WHERE usename='{service}' ORDER BY age DESC LIMIT 20;\"", note: 'Read-only' }, { cmd: 'psql -h {db} -c "SELECT pg_terminate_backend(<pid>);"', note: 'Only for a confirmed stuck session' }] },
        { id: 'leak-detection', title: 'Turn on leak detection and add a timeout', why: 'Prevents a recurrence and points at the code that does not return connections.', steps: ['Set a leak detection threshold (for example 20 s) in the pool config.', 'Set statement and transaction timeouts.', 'Add pool saturation to alerts.'], commands: [{ cmd: 'kubectl -n {ns} set env deployment/{service} SPRING_DATASOURCE_HIKARI_LEAK_DETECTION_THRESHOLD=20000', note: '' }] }
      ],
      collect: ['Pool metrics: active, idle and pending connections', 'Database pg_stat_activity during the incident', 'Recent config changes to the datasource']
    },
    {
      id: 'memory-leak-oom', title: 'Memory leak, OOMKilled and crash loop', category: 'Resources', builtin: true,
      summary: 'Memory climbs until the container hits its limit, the kernel kills it (exit code 137, OOMKilled), Kubernetes restarts it, and it crash-loops.',
      cause: '{service} ran out of memory and was OOMKilled repeatedly, leaving it in a crash loop.',
      changeTypes: ['deploy', 'config', 'traffic'], changeKeywords: ['memory', 'heap', 'cache', 'limit', 'resources'], metric: { re: 'mem|heap|rss', direction: 'up' },
      signals: [
        S('oom', 'OOMKilled / exit code 137 / heap out of memory', 'OOMKill(?:ed|ing)|exit code:? 137|Out of memory: Killed process|java\\.lang\\.OutOfMemoryError|JavaScript heap out of memory|Reached heap limit|MemoryError|memory limit exceeded|fatal error: runtime: out of memory|Memory cgroup out of memory', 'cause', 3),
        S('gc-pressure', 'GC pressure and rising heap', 'GC overhead limit|long GC pause|heap used [\\d.]+\\s*[GM]B|Mark-sweep|allocation failure|heap usage (?:at|above) \\d+%', 'cause', 1),
        S('crashloop', 'CrashLoopBackOff / restarts', 'CrashLoopBackOff|Back-off restarting failed container|Restart Count:\\s*[3-9]|container .* restarted', 'symptom', 1.5),
        S('unready', 'Readiness/liveness failures', 'Readiness probe failed|Liveness probe failed|Unhealthy', 'symptom', 0.5)
      ],
      fixes: [
        { id: 'raise-limit', title: 'Raise the memory limit to buy time', why: 'Stops the crash loop while you find the leak. It does not fix a leak; memory will climb again.', steps: ['Raise the limit by a margin (for example 1.5x).', 'Watch memory slope after restarts to confirm it is a leak, not just undersized.', 'Open a follow-up to fix the leak.'], commands: [{ cmd: 'kubectl -n {ns} set resources deployment/{service} --limits=memory=3Gi --requests=memory=2Gi', note: 'Example sizes' }, { cmd: 'kubectl -n {ns} top pod -l app={service}', note: 'Read-only' }], simulate: 'Raise memory limit on deployment/{service}' },
        { id: 'heap-snapshot', title: 'Capture a heap snapshot before the next kill', why: 'The only reliable way to find what is retaining memory.', steps: ['Pick a pod whose memory is high but not yet killed.', 'Take a heap snapshot or heap dump.', 'Compare two snapshots a few minutes apart.'], commands: [{ cmd: 'kubectl -n {ns} exec {pod} -- node --heapsnapshot-signal=SIGUSR2 -e 0', note: 'Node: or send SIGUSR2 if enabled' }, { cmd: 'kubectl -n {ns} exec {pod} -- jcmd 1 GC.heap_dump /tmp/heap.hprof', note: 'JVM services' }] },
        { id: 'rollback-leak', title: 'Roll back if a recent release introduced the leak', why: 'If memory growth started with a release, rolling back stops it.', steps: ['Compare memory slope before and after the last release.', 'Roll back if the slope changed with the release.'], commands: [{ cmd: 'kubectl -n {ns} rollout undo deployment/{service}', note: '' }] },
        { id: 'restart-all', title: 'Restart all pods (last resort)', why: 'Clears memory everywhere at once, but drops in-flight work and hides the evidence.', steps: ['Prefer a heap snapshot first.', 'Restart only if users are badly affected and the limit change is not possible.'], commands: [{ cmd: 'kubectl -n {ns} rollout restart deployment/{service}', note: 'Restarts every pod' }] }
      ],
      collect: ['Memory usage per pod over the last 24 hours', 'kubectl describe pod for Last State and Restart Count', 'Heap snapshot from a pod with high memory']
    },
    {
      id: 'tls-expired', title: 'Expired or invalid TLS certificate', category: 'Security', builtin: true,
      summary: 'A certificate in the request path expired (or its chain is not trusted), so TLS handshakes fail and every call to that host errors at once, often at a round hour.',
      cause: 'The TLS certificate for {host} expired, so handshakes from {service} fail.',
      changeTypes: ['cert', 'infra', 'config'], changeKeywords: ['cert', 'certificate', 'tls', 'ssl', 'ca bundle', 'trust'], roundHour: true,
      signals: [
        S('expired', 'Certificate has expired / verify failed', 'certificate has expired|x509: certificate has expired|CERT_HAS_EXPIRED|certificate verify failed|CERTIFICATE_VERIFY_FAILED|SSLHandshakeException|PKIX path (?:building|validation) failed|certificate is not yet valid|ssl_error_expired|NotAfter', 'cause', 3),
        S('handshake', 'TLS handshake failures', 'handshake failure|tls: handshake|SSL routines|bad certificate|unknown (?:ca|authority)|self[- ]signed certificate', 'cause', 1),
        S('edge-5xx', 'HTTP 5xx at the edge', '^(?:GET|POST|PUT|PATCH|DELETE) \\S+ 50[0-9]$|Bad Gateway', 'symptom', 0.5),
        S('dependent-failure', 'Calls to the dependency failing', 'charge failed|payment failed|upstream (?:request )?failed|failed to call|refund .* failed|retrying charge|will retry', 'symptom', 0.5)
      ],
      fixes: [
        { id: 'check-cert', title: 'Confirm the expiry on {host}', why: 'Proves the cause in one command and tells you which certificate to replace.', steps: ['Read the certificate dates from the host.', 'Check whether it is your certificate or the partner\u2019s.'], commands: [{ cmd: 'openssl s_client -connect {host}:443 -servername {host} </dev/null 2>/dev/null | openssl x509 -noout -dates -subject -issuer', note: 'Read-only' }] },
        { id: 'renew', title: 'Renew or rotate the certificate', why: 'If the certificate is yours, renew it and roll it out. If it is a partner\u2019s, contact them and ask for the new chain.', steps: ['Renew through your certificate manager.', 'Reload the services that terminate TLS.', 'Re-run the expiry check.'], commands: [{ cmd: 'cmctl renew -n {ns} {cert}', note: 'cert-manager' }, { cmd: 'kubectl -n {ns} get certificate {cert} -o wide', note: 'Read-only' }], simulate: 'Renew certificate {cert} and reload ingress' },
        { id: 'dont-disable', title: 'Do not turn off certificate verification', why: 'Disabling checks (curl -k, verify=False) "fixes" errors by removing protection. Shown only so it can be recognised and refused.', steps: ['Refuse any change that disables verification, even temporarily.'], commands: [{ cmd: 'NODE_TLS_REJECT_UNAUTHORIZED=0 node server.js', note: 'Never do this in production' }] },
        { id: 'expiry-alerts', title: 'Add expiry monitoring', why: 'Prevents a repeat: alert 30, 14 and 3 days before any certificate in the path expires, including partners\u2019.', steps: ['Add {host} to certificate expiry checks.', 'Page the owning team at 3 days.'], commands: [] }
      ],
      collect: ['Certificate dates (openssl s_client) for each host in the failing call path', 'Whether the failure started at an exact hour (typical of expiry)', 'Partner status page or announcements']
    },
    {
      id: 'dns-dependency', title: 'DNS resolution or dependency outage', category: 'Network', builtin: true,
      summary: 'A service cannot resolve or reach a dependency. Lookups fail (no such host, EAI_AGAIN, SERVFAIL) or connections are refused, so calls error and gateways return 502 or 503.',
      cause: '{service} could not resolve or reach {host}, so calls to that dependency failed.',
      changeTypes: ['config', 'infra', 'dns', 'network'], changeKeywords: ['dns', 'coredns', 'resolver', 'resolv', 'nameserver', 'forward', 'upstream', 'network policy', 'vpc'],
      signals: [
        S('dns-fail', 'Name resolution failures', 'getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|no such host|Name or service not known|Temporary failure in name resolution|SERVFAIL|NXDOMAIN|could not resolve host|UnknownHostException|lookup \\S+ on \\S+: (?:server misbehaving|read udp|i\\/o timeout)|plugin\\/errors', 'cause', 3),
        S('conn-refused', 'Connection refused / unreachable dependency', 'ECONNREFUSED|connection refused|no route to host|EHOSTUNREACH|network is unreachable|connect ETIMEDOUT', 'cause', 1),
        S('upstream-5xx', 'Gateway 502/503 and upstream errors', '\\b50[23]\\b|upstream connect error|no healthy upstream|Service Unavailable|Bad Gateway', 'symptom', 1),
        S('breaker', 'Circuit breaker opened', 'circuit (?:breaker )?(?:is )?open|breaker tripped', 'symptom', 0.5)
      ],
      fixes: [
        { id: 'check-dns', title: 'Check resolution from inside the cluster', why: 'Confirms whether DNS is the problem and which resolver answers.', steps: ['Resolve the failing name from a debug pod.', 'Check CoreDNS pods and their logs.'], commands: [{ cmd: 'kubectl -n {ns} run dnscheck --rm -it --image=busybox:1.36 --restart=Never -- nslookup {host}', note: 'Creates a short-lived pod' }, { cmd: 'kubectl -n kube-system logs -l k8s-app=kube-dns --since=30m', note: 'Read-only' }] },
        { id: 'revert-dns', title: 'Revert the DNS / resolver change', why: 'If the resolver config changed just before errors began, put the old upstream back.', steps: ['Restore the previous CoreDNS forward config.', 'Wait for the config reload (about 30 s) and re-test resolution.'], commands: [{ cmd: 'kubectl -n kube-system apply -f coredns-configmap.previous.yaml', note: 'Your saved previous config' }], simulate: 'Restore previous CoreDNS forward configuration' },
        { id: 'degrade', title: 'Degrade gracefully while the dependency is down', why: 'Serve cached results or a reduced page instead of errors.', steps: ['Turn on cached or fallback responses for {service}.', 'Tell users through the status page.'], commands: [{ cmd: 'flagctl set {service}.serve_stale on --env production', note: 'Fictional flag CLI' }] }
      ],
      collect: ['nslookup or dig output from an affected pod', 'CoreDNS logs and metrics (SERVFAIL rate)', 'Network or resolver changes in the last day']
    },
    {
      id: 'disk-full', title: 'Disk full', category: 'Resources', builtin: true,
      summary: 'A volume filled up, so writes fail (No space left on device) and services crash or stop logging.',
      cause: 'A volume used by {service} ran out of space.', changeTypes: ['config', 'deploy'], changeKeywords: ['log level', 'retention', 'disk', 'volume'],
      signals: [S('enospc', 'No space left on device', 'No space left on device|ENOSPC|disk quota exceeded|DiskPressure|disk full|filesystem is full', 'cause', 3), S('write-fail', 'Write failures', 'failed to write|could not write|write error', 'symptom', 1)],
      fixes: [{ id: 'find-usage', title: 'Find what is using the space', why: 'Free space safely by removing the right things.', steps: ['List the biggest directories.', 'Rotate or compress logs before deleting anything.'], commands: [{ cmd: 'kubectl -n {ns} exec {pod} -- du -xh / --max-depth=2 | sort -h | tail -20', note: 'Read-only' }, { cmd: 'kubectl -n {ns} exec {pod} -- rm -rf /var/log/app/old/*', note: 'Deletes files' }] }, { id: 'expand', title: 'Expand the volume', why: 'More room while you fix retention.', steps: ['Resize the PVC if the storage class allows it.'], commands: [{ cmd: 'kubectl -n {ns} patch pvc {pvc} -p \'{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}\'', note: '' }] }],
      collect: ['Disk usage per volume over time', 'Log volume per service']
    },
    {
      id: 'rate-limited', title: 'Rate limited by a dependency', category: 'Dependency', builtin: true,
      summary: 'A dependency or API returns 429 Too Many Requests, often after a traffic spike or a retry storm.',
      cause: '{service} hit a rate limit on a dependency.', changeTypes: ['traffic', 'config'], changeKeywords: ['rate', 'quota', 'retry', 'batch'],
      signals: [S('r429', 'HTTP 429 / rate limit errors', '\\b429\\b|Too Many Requests|rate limit(?:ed| exceeded)|throttl(?:ed|ing)|quota exceeded|SlowDown', 'cause', 3), S('retry-storm', 'Retry storm', 'retry(?:ing)? \\d+/\\d+|retries exhausted|backing off', 'context', 1)],
      fixes: [{ id: 'backoff', title: 'Add jittered backoff and cap retries', why: 'Retries without backoff turn a small limit into an outage.', steps: ['Cap retries and add exponential backoff with jitter.', 'Ask the provider for a higher limit if traffic is legitimate.'], commands: [] }],
      collect: ['Request rate to the dependency', 'The provider\u2019s limit headers (Retry-After, X-RateLimit-*)']
    }
  ];
  const PAST = [
    { id: 'PIR-0931', title: 'Checkout errors after price service release', date: '2026-08-21', service: 'checkout-api', patternId: 'bad-deploy', rootCause: 'A release assumed every cart line had a currency object; legacy carts did not. TypeError on formatPrice for about 30% of checkouts.', fix: 'Rolled back within 12 minutes; fixed forward with a null check and a regression test.', tags: ['rollback', 'TypeError', 'checkout', '500'] },
    { id: 'PIR-0874', title: 'Orders API timeouts during flash sale', date: '2026-06-02', service: 'orders-svc', patternId: 'db-pool-exhaustion', rootCause: 'A slow report query held connections while traffic tripled; HikariPool ran dry and the gateway returned 504s.', fix: 'Moved the report to a replica, raised the pool from 20 to 40, added leak detection.', tags: ['hikari', 'pool', '504', 'postgres'] },
    { id: 'PIR-0902', title: 'Recommendations crash loop after cache change', date: '2026-07-15', service: 'recs-svc', patternId: 'memory-leak-oom', rootCause: 'An unbounded in-memory cache grew with every request until pods were OOMKilled.', fix: 'Raised memory limit for relief, then bounded the cache with LRU eviction.', tags: ['OOMKilled', 'CrashLoopBackOff', 'cache', 'heap'] },
    { id: 'PIR-0815', title: 'Partner webhook TLS failures', date: '2026-03-30', service: 'payments-svc', patternId: 'tls-expired', rootCause: 'An intermediate certificate in the partner chain expired at midnight UTC.', fix: 'Partner rotated the chain; we added expiry monitoring for partner hosts.', tags: ['x509', 'certificate', 'partner'] },
    { id: 'PIR-0950', title: 'Search outage after resolver migration', date: '2026-09-09', service: 'search-svc', patternId: 'dns-dependency', rootCause: 'CoreDNS was pointed at a new upstream resolver that dropped UDP from the pod network; lookups for internal names timed out.', fix: 'Reverted the forward config; added a synthetic DNS check.', tags: ['coredns', 'EAI_AGAIN', 'dns', '503'] },
    { id: 'PIR-0788', title: 'Log volume filled node disks', date: '2026-02-11', service: 'ingest-worker', patternId: 'disk-full', rootCause: 'Debug logging left on after an investigation filled node disks.', fix: 'Turned off debug logging and added log rotation limits.', tags: ['disk', 'ENOSPC'] }
  ];
  /* Compile a pattern's regexes once; bad user regexes are reported, not thrown. */
  function compile(p) { const errors = []; const signals = (p.signals || []).map((s) => { try { return Object.assign({}, s, { rx: new RegExp(s.re, 'i') }); } catch (e) { errors.push(s.label + ': ' + e.message); return Object.assign({}, s, { rx: null }); } }); return Object.assign({}, p, { signals, errors }); }
  function validate(p) {
    const errs = [];
    if (!p.title || !String(p.title).trim()) errs.push('Add a title.');
    if (!(p.signals || []).length) errs.push('Add at least one log signal.');
    for (const s of p.signals || []) { if (!s.re) { errs.push('Each signal needs a pattern.'); continue; } try { const rx = new RegExp(s.re, 'i'); if (rx.test('') ) errs.push('"' + s.label + '" matches every line; make it more specific.'); } catch (e) { errs.push('"' + (s.label || s.re) + '" is not a valid regular expression: ' + e.message); } }
    if (!(p.signals || []).some((s) => s.role === 'cause')) errs.push('Mark at least one signal as a cause (symptoms alone never make a root cause).');
    return errs;
  }
  return { PATTERNS, PAST, compile, validate };
});
