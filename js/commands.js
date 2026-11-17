/* IncidentLens command safety: suggested commands are only ever shown as text to copy; this page cannot run
   anything. Each command is classified as read-only, a change, or risky. Risky commands (deleting, dropping,
   restarting or scaling production to zero, force-pushing, disabling TLS checks...) carry a blast-radius warning
   and need an explicit acknowledgement before they can be copied. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.IL = root.IL || {}).commands = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RISKY = [
    { id: 'k8s-delete', re: /\bkubectl\b[^|;&]*\s(delete|drain)\b/i, blast: 'Deletes or evicts Kubernetes resources. Pods, services or volumes in the target namespace can be lost and may not come back on their own.' },
    { id: 'sql-drop', re: /\b(drop\s+(table|database|schema|index|user)|truncate(\s+table)?\s+\w)/i, blast: 'Permanently destroys data or schema objects. Only a restore from backup brings them back.' },
    { id: 'sql-delete-all', re: /\bdelete\s+from\s+[\w."]+\s*(;|$)(?![\s\S]*\bwhere\b)/i, blast: 'Deletes every row in the table (there is no WHERE clause).' },
    { id: 'kill-sessions', re: /\bpg_terminate_backend\b|\bkill\s+(query|connection)\b|\bKILL\s+\d+/i, blast: 'Terminates live database sessions. In-flight transactions roll back and clients see errors.' },
    { id: 'rm-rf', re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive)\b/i, blast: 'Recursively deletes files with no confirmation and no undo.' },
    { id: 'scale-zero', re: /\bscale\b[^|;&]*--replicas[= ]0\b|\bdesired-capacity\s+0\b|\bmin-size\s+0\b/i, blast: 'Scales the service to zero. It goes fully offline until scaled back up.' },
    { id: 'restart-prod', re: /\b(rollout\s+restart|systemctl\s+restart|service\s+\S+\s+restart|docker\s+restart|reboot\b|pm2\s+restart|kill\s+-9)\b/i, blast: 'Restarts every instance at once. In-flight requests drop, caches go cold, and if the cause is still there it can make things worse.' },
    { id: 'force-push', re: /\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\w)/i, blast: 'Rewrites shared history on the remote. Teammates can lose commits.' },
    { id: 'destroy-infra', re: /\b(terraform\s+(destroy|apply\s+-auto-approve)|pulumi\s+destroy|helm\s+(uninstall|delete)|aws\s+\S+\s+(delete|terminate|remove)[\w-]*|gcloud\s+\S+(\s+\S+)?\s+delete|az\s+\S+\s+delete)\b/i, blast: 'Tears down cloud infrastructure. Dependent services break and data on removed resources can be lost.' },
    { id: 'flush-cache', re: /\b(FLUSHALL|FLUSHDB)\b/, blast: 'Empties the cache. Every request then hits the database, which can overload it (a thundering herd).' },
    { id: 'disable-tls', re: /(\s-k\b|\s--insecure\b|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|InsecureSkipVerify\s*:\s*true|-Dcom\.sun\.net\.ssl\.checkRevocation=false|sslmode=disable)/, blast: 'Turns off certificate checks. Traffic can be intercepted; never ship this as the fix for an expired certificate.' },
    { id: 'firewall-open', re: /\b(iptables\s+-F|ufw\s+disable|0\.0\.0\.0\/0)\b/i, blast: 'Removes network protections or opens access to the whole internet.' },
    { id: 'chmod-777', re: /\bchmod\s+(-R\s+)?777\b/i, blast: 'Makes files writable by every user on the machine.' }
  ];
  const CHANGE = /\b(kubectl\b[^|;&]*\s(apply|set|patch|edit|scale|annotate|label|cordon|rollout\s+undo|autoscale|create)|helm\b[^|;&]*\s(upgrade|rollback|install)|delete\s+from|argocd\s+app\s+(rollback|sync)|terraform\s+apply|git\s+(revert|push|commit|reset)|alter\s+(table|system|database)|update\s+\w+\s+set|insert\s+into|cmctl\s+renew|certbot\s+renew|systemctl\s+(reload|start|stop)|aws\s+\S+\s+(update|put|modify|create)[\w-]*|feature-flag|flagctl|psql\b[^|]*-c\s+"?(alter|update|insert))/i;
  /* Returns { level: 'read'|'change'|'risky', reasons:[{id, blast}], prod } */
  function classify(cmd) {
    const c = String(cmd || ''); const reasons = RISKY.filter((r) => r.re.test(c)).map((r) => ({ id: r.id, blast: r.blast }));
    const prod = /\b(prod|production|live|-n\s+shop\b|--namespace[= ]shop\b|primary)\b/i.test(c);
    if (reasons.length) return { level: 'risky', reasons, prod };
    if (CHANGE.test(c)) return { level: 'change', reasons: [{ id: 'change', blast: prod ? 'Changes production. Have a rollback ready and watch the dashboards while it applies.' : 'Changes a running system. Have a rollback ready.' }], prod };
    return { level: 'read', reasons: [], prod };
  }
  /* Fill {placeholders} from context; unknown ones stay visible as <placeholder> so nothing is silently guessed. */
  function fill(cmd, ctx) { return String(cmd).replace(/\{(\w+)\}/g, (m, k) => (ctx && ctx[k] != null && ctx[k] !== '' ? String(ctx[k]) : '<' + k + '>')); }
  return { RISKY, classify, fill };
});
