/* IncidentLens Web Worker: streams dropped files through the ingest pipeline off the main thread, so large
   logs don't freeze the page. Messages: { sources:[{ name, file?|text? }], opts } in; progress and the result out. */
/* global importScripts */
importScripts('text.js', 'redact.js', 'parse.js', 'guard.js', 'cluster.js', 'pipeline.js');
self.onmessage = async (ev) => {
  const { sources, opts } = ev.data || {};
  try {
    const p = self.IL.pipeline.createPipeline(opts || {});
    const total = (sources || []).reduce((a, s) => a + (s.file ? s.file.size : (s.text || '').length), 0) || 1; let done = 0; let last = 0;
    for (const s of sources || []) {
      const a = p.addSource(s.name, {});
      if (s.file) {
        const reader = s.file.stream().pipeThrough(new TextDecoderStream()).getReader();
        for (;;) { const { value, done: d } = await reader.read(); if (d) break; a.push(value); done += value.length; const now = Date.now(); if (now - last > 120) { last = now; self.postMessage({ type: 'progress', done, total, name: s.name }); } }
      } else { const t = String(s.text || ''); for (let i = 0; i < t.length; i += 262144) { a.push(t.slice(i, i + 262144)); done += Math.min(262144, t.length - i); self.postMessage({ type: 'progress', done, total, name: s.name }); } }
      a.end();
    }
    self.postMessage({ type: 'done', result: p.finish() });
  } catch (e) { self.postMessage({ type: 'error', message: String((e && e.message) || e) }); }
};
