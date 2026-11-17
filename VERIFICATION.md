# Verification

Checked on 2026-11-17 against the live site, https://shaikbasha1437.github.io/incidentlens-ai/

## Unit tests

`npm test` runs Node's built-in test runner. **76 tests, 76 passing.** They cover:

- **Parsing:** JSON lines, nginx access logs, syslog, Kubernetes events, Python and Java stack traces, logfmt, Datadog-style CSV, and streaming at chunk sizes from 1 to 64 characters.
- **Sampling:** a flood of info lines can't push out later errors.
- **Redaction:**
  - Every secret type is caught.
  - There are no false positives on timestamps, trace IDs, UUIDs, versions, pod names, durations or order numbers.
  - Card numbers are Luhn-checked.
  - IP redaction can be turned on.
- **Prompt injection:** it is flagged, and ordinary error lines are not. The prompt fence can't be broken out of.
- **Clustering:** Drain masking. 200s and 500s never merge.
- **Detection:** spikes, new signatures, OOM kills and crash loops. The timeline stays at 90 bars or fewer.
- **Change lists:** lines, CSV and JSON all parse; instruction-like changes are flagged.
- **Ground truth:** every demo incident's top hypothesis is checked, including the one that should abstain. Citations must exist, cause and symptom evidence are kept apart, and flagged lines are never evidence. The deploy correlation and the red-herring change are checked too.
- **Injection invariance:** removing the injected lines gives the same verdict and confidence. An injected line alone cannot create a hypothesis.
- **Commands:** read-only, change and risky classes, blast-radius text and placeholders.
- **Live mode:**
  - request shapes for OpenAI, Anthropic (browser-access header), Gemini and OpenAI-compatible endpoints
  - readable bad-key errors
  - the prompt leaves out flagged lines and secrets
  - uncited claims or citations to lines that were not sent are withheld
  - parroted injections are withheld
  - mocked end to end for all four providers, with the key never in the body
- **Exports:**
  - The status page draft has no internal names.
  - Postmortem sections pass the blame lint, and the lint catches blame.
  - CSV escaping and formula guard.
  - Backups contain no keys and round-trip.
  - Pattern validation.
- **Static checks:** every script parses, the service worker caches every module, and the manifest icons exist.
- **Hygiene:** no numbering labels or visa wording, no real-looking keys, and only `.example` addresses.

## Demo ground truth

**6 / 6.** Each line shows the expected cause and the top hypothesis with its confidence:

- **INC-2041** bad deploy → Bad deploy or regression, 86%
- **INC-2042** pool exhaustion → Database connection pool exhaustion, 87%. It is pinned on the pool-size config change, not the frontend deploy red herring.
- **INC-2043** memory leak → Memory leak, OOMKilled and crash loop, 82%
- **INC-2044** expired certificate → Expired or invalid TLS certificate, 73%
- **INC-2045** DNS → DNS resolution or dependency outage, 80%
- **INC-2046** ambiguous → abstains and lists what to collect

These incidents were written to exercise the built-in patterns, so this measures whether the engine works as designed. It is not accuracy on real outages.

## Browser tests (Playwright, live site, not committed)

| Browser | Result |
|---|---|
| Chrome (stable) | **168 / 168** |
| Firefox (Playwright build) | **166 / 166** |

Firefox runs two fewer checks because Playwright can't read the clipboard there: the acknowledged risky copy reaching the clipboard, and its timeline note.

What the checks cover:

- **Load:** the eyebrow, six demo incidents, demo mode, the service worker, and no numbering or visa wording.
- **Ground truth in the UI:** all six verdicts. The abstention lists data to collect.
- **Citations:** clicking a cause line opens Logs with the line highlighted and in view.
- **Safety:**
  - The card number, bearer token and email are never shown or stored.
  - Redactions and the two injection lines are listed, and the injected text appears in no hypothesis.
  - The flagged-only filter works.
- **Timeline:** clicking a bar filters by time. Change and anomaly markers open by mouse and by keyboard. "Logs around this change" works, and so does the metric overlay.
- **Logs and clusters:** search (keeping focus), regex, the level filter, paging, the template filter and the CSV download with no secrets.
- **Fixes:**
  - Read-only commands copy directly.
  - A risky command shows its blast radius, and copying is blocked until it is acknowledged. The acknowledgement is recorded.
  - The command checker works.
  - Choosing a non-top hypothesis shows a warning.
- **Simulation:** the approver and the approval box are required. The mock output says nothing ran, and the run is recorded in the timeline.
- **Workspace:**
  - status changes with undo
  - notes, including a discard prompt and delete with undo
  - draft edit and regenerate; the status page draft has no internal names
  - the blame lint warns while you type
  - postmortem MD/JSON downloads
  - a blank required title doesn't block Cancel
- **Library:**
  - A symptom-only pattern is refused.
  - Add and delete with undo.
  - Turning a pattern off changes the verdict, and turning it back on restores it.
  - Past incident delete with undo.
  - Signal counts are shown.
  - Back closes the modal.
- **Change list:** an unreadable list is refused; save and undo.
- **Import:**
  - A pasted incident is created with secrets redacted, and the create can be undone.
  - A 4.7 MB file goes through the Web Worker with a progress bar in under 1 s and is analysed correctly.
- **Modals:** Help, Export, Settings and Import each close via X, Cancel, Esc, backdrop click and browser Back. Unsaved edits ask before discarding, and focus stays inside the modal.
- **Live mode** (stubbed OpenAI route):
  - A key is required.
  - The cited hypothesis is shown and the uncited one withheld.
  - The key travels only in the Authorization header.
  - No flagged or secret text is sent.
  - The backup and report contain no key.
  - "Forget keys" clears storage.
- **Export:** CSV, postmortem, backup. Reset can be undone. Restore works, a bad backup gets an explanation, and data persists across a reload.
- **Display:**
  - The dark theme persists.
  - No horizontal overflow at 375px on any tab or in the import, settings, export or pattern modals.
  - The app reloads offline from the service worker.
- **No page errors.**

**Large file (separate script, live site):** a 59.4 MB, 500,000-line log took 4.1 s in Chrome and 5.2 s in Firefox. The page never blocked for more than 0.3 s. All 9,999 error lines were kept and redacted, the verdict was memory leak / OOM, and the result persisted across a reload.

## Bugs found and fixed during verification

1. **Errors could be dropped behind a flood of info lines.** Info lines filled the shared keep limit, so errors near the end of a 500k-line file were dropped and the analysis abstained. Warnings and errors now have their own budget, and a regression test covers it.
2. **Focus could escape a modal** if Tab was pressed just after it opened. The trap now pulls focus back in.
3. **"Forget keys" left an empty key object in localStorage** while "remember" was on.
4. **Unfilled placeholders** such as `{prev}` showed in command notes and fix reasons.
5. **"email addresss"** plural, and the misaligned signal-editor grid.
6. **The live-mode prompt was thin (about 14 lines).** It now includes context around the evidence and more examples per template, and the UI wording changed from "about 160 lines" to "up to 160 lines".
7. **The theme toggle set the wrong attribute.** It now uses the `dark` class that the stylesheet reads.

## Not tested / limits

- No real provider was called; live mode was tested only with stubbed responses. WebLLM was not exercised because there is no WebGPU here.
- Safari and mobile hardware were not tested. 375px was checked with Chrome and Firefox viewports.
- The pattern engine only knows the patterns in its library. Redaction is pattern based. Times are UTC.
