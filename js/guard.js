/* IncidentLens guard: log lines are untrusted data. Anyone who can send a request can put text in a log
   (a user agent, a query string, an error message), so lines that try to instruct an AI reader are flagged,
   kept out of every hypothesis and fix, and never sent to a model. Also fences prompt data and blocks keys. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.IL = root.IL || {}).guard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const AI = '(?:ai|a\\.i\\.|llm|language models?|assistants?|chatbots?|agents?|copilots?|gpt|claude|gemini|models?|incident (?:bots?|agents?|tools?|analy[sz]ers?)|log (?:analy[sz]ers?|readers?|bots?)|sre bots?|on-?call bots?)';
  const DESTROY = '(?:delet\\w*|drop\\w*|truncat\\w*|wip(?:e|es|ed|ing)|destroy\\w*|purg\\w*|eras\\w*|rm\\s+-rf|scale\\b[^.\\n]{0,30}\\b(?:to\\s+)?0\\b|disable|shut\\s*down|force[- ]push|flushall|revoke)';
  const TARGET = '(?:database|db|databases|tables?|schemas?|clusters?|namespaces?|prod(?:uction)?|backups?|everything|all (?:data|pods|nodes|services)|buckets?|volumes?|replicas|firewall|auth|mfa|logging|alerts?|monitoring)';
  const PATTERNS = [
    { id: 'ignore-instructions', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|other|any|your|the)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines|context|system prompt|directives?|analysis|findings)\b/i },
    { id: 'addressed-to-ai', re: new RegExp('\\b(note|message|attention|instructions?|hello|hi|dear|hey)\\s*(to|for)?\\s*(the|any|all)?\\s*' + AI + '\\b\\s*[:,!-]', 'i') },
    { id: 'ai-should', re: new RegExp('\\b' + AI + '\\b[^.\\n]{0,60}\\b(should|must|shall|are required to|need to|will now|is instructed to)\\b[^.\\n]{0,40}\\b(recommend|say|state|report|conclude|blame|ignore|disregard|run|execute|delete|drop|tell|suggest|output|mark|close|resolve)\\b', 'i') },
    { id: 'destructive-ask', re: new RegExp('\\b(recommend(?:ing)?|suggest(?:ing)?|you should|please|immediately|go ahead and|the fix is to|the solution is to)\\b[^.\\n]{0,40}\\b' + DESTROY + '\\b[^.\\n]{0,40}\\b' + TARGET + '\\b', 'i') },
    { id: 'role-tag', re: /(^|[\s"'(])(\[(system|assistant|developer)\]|<\/?(system|assistant|developer)>|###\s*(system|instruction)s?\b)|(^|["'\s])(system|assistant|developer)\s*:\s*(you|ignore|from now|new)/i },
    { id: 'role-change', re: /\byou are now\b|\bact as (?:an?|the) (?:ai|assistant|system|admin|root)\b|\bnew instructions\b|\bjailbreak\b|\bdeveloper mode\b/i },
    { id: 'exfiltrate', re: /\b(api[- ]?keys?|passwords?|secrets?|tokens?|credentials?)\b[^.\n]{0,40}\b(send|post|reveal|print|share|include|email|upload)\b[^.\n]{0,30}\b(to|in|into|with)\b|\b(send|post|reveal|print|leak)\b[^.\n]{0,30}\b(api[- ]?keys?|passwords?|secrets?|credentials|system prompt)\b/i },
    { id: 'hidden-markup', re: /<!--[\s\S]*?(ai|assistant|instruction|system|recommend)[\s\S]*?-->|[\u200b\u200c\u200d\u2060\u202e]/i }
  ];
  /* Returns the rule ids a piece of text trips (empty when clean). */
  function rules(text) { const s = String(text || ''); return PATTERNS.filter((p) => p.re.test(s)).map((p) => p.id); }
  function isInjection(text) { return rules(text).length > 0; }
  /* Neutralise anything that could close or forge our fence. */
  function sanitize(text) { return String(text || '').replace(/<\/?\s*(untrusted_logs?|logs?|source|system|instructions?|assistant|developer)[^>]*>/gi, (m) => m.replace(/</g, '\u2039').replace(/>/g, '\u203A')); }
  function fence(id, body, withheld) {
    const warn = withheld ? '\n[guard: ' + withheld + ' instruction-like line(s) were withheld from this data before you saw it]' : '';
    return '<untrusted_logs id="' + String(id).replace(/[^\w-]/g, '') + '">' + warn + '\n' + sanitize(body) + '\n</untrusted_logs>';
  }
  const KEYLIKE = /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g;
  function redactKeys(s) { return String(s || '').replace(KEYLIKE, '[redacted key]'); }
  /* Last line of defence before a prompt leaves the page. */
  function assertNoSecrets(prompt, secrets) {
    const p = String(prompt || '');
    for (const k of secrets || []) if (k && k.length >= 6 && p.indexOf(k) >= 0) throw new Error('Blocked: a prompt contained one of your keys. Nothing was sent.');
    return p;
  }
  return { PATTERNS, rules, isInjection, sanitize, fence, redactKeys, assertNoSecrets, KEYLIKE };
});
