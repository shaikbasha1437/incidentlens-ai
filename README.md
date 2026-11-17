# IncidentLens AI

**An incident agent that reads logs, ranks likely root causes with the exact log lines behind them, and suggests safe fixes, in your browser.**

[Live app](https://shaikbasha1437.github.io/incidentlens-ai/) · MIT licensed · demo mode needs no key

Paste or drop logs, an optional metrics CSV and a list of recent changes. IncidentLens parses and clusters the logs, finds anomalies, lines them up with deploys on a timeline, and ranks root-cause hypotheses. Every hypothesis cites the log lines it rests on, keeps causes apart from symptoms, and comes with a confidence. When the evidence is thin it says so and lists what to collect next instead of guessing. Fixes come as runbook steps and commands you copy yourself. Nothing is run and nothing is sent.

The demo uses Brightcart, a fictional online store, with six incidents whose root cause is known. Every address is on a `.example` domain.

## What it does

- **Reads many log formats.** JSON lines, logfmt, nginx/Apache access logs, syslog (RFC 3164 and 5424), Kubernetes events, `kubectl describe` and pod logs, Spring Boot, Python and Go formats, and CSV or JSON exports from Datadog and CloudWatch. Python, Java and Node stack traces are joined onto the line that threw. Big files are streamed through a Web Worker so the page stays responsive. Warnings, errors, stack traces and Kubernetes events are kept up to 60,000. Info lines keep their own smaller budget: the first 15,000, then a thinning sample up to 24,000. A flood of info lines can't push out the errors that come after it, and every line still counts toward the timeline and the clusters.
- **Clusters the noise.** A Drain-style template miner turns thousands of lines into a few dozen templates. The miner masks IDs, numbers, IPs, pod names, durations and secrets, and keeps the HTTP status as part of each template.
- **Detects anomalies.** It flags:
  - error spikes and new error signatures
  - latency jumps
  - out-of-memory kills, crash loops and climbing memory
  - error metrics
  
  These are drawn on a clickable timeline with your deploys and changes. Click a bar to see that minute's logs, or a marker to see the change or anomaly.
- **Ranks hypotheses.** A library of failure patterns scores the evidence:
  - bad deploy
  - database pool exhaustion
  - memory leak / OOMKilled
  - expired TLS certificate
  - DNS or dependency outage
  - disk full
  - rate limiting

  Only *cause* signals can make a root cause. 500s, timeouts and restarts are treated as symptoms. Changes that land just before the first anomaly raise the score; one that lands afterwards counts against it. The confidence formula is in [`js/analyze.js`](js/analyze.js). IncidentLens abstains when:
  - nothing matches
  - there are fewer than three cause lines
  - confidence is under 50%
  - two causes are nearly tied
- **Shows its evidence.** Each citation names the line (`L861`), source file, line number and time. Click it to jump to the line in the log explorer.
- **Fixes and runbooks.** Steps and commands are filled in with the service, namespace and versions. Each command is labelled read-only, changes a system, or risky. Risky ones (deleting resources, terminating database sessions, turning off TLS checks, restarts, scaling to zero, `rm -rf`, unscoped `DELETE`) show their blast radius and need an acknowledgement before they are copied. The acknowledgement is recorded in the timeline. "Simulate" plays a mock run behind an approval step. There is also a checker for any command you paste.
- **Incident workspace.** It holds:
  - severity, status, owner and incident commander
  - timeline notes
  - draft updates for Slack, the status page and stakeholders. The public status page draft leaves out internal names. Drafts are never sent.
  - a blameless postmortem draft with a blame-language check, exported as Markdown or JSON
- **Library.** You can edit the built-in patterns, add your own, and turn any of them off; the analysis re-runs straight away. Past incidents (fictional write-ups) are retrieved with BM25 when they look related.
- **Exports.** You can export:
  - an incident report (Markdown)
  - the postmortem (Markdown or JSON)
  - the log clusters (CSV, guarded against formula injection)
  - a full backup (JSON)
  
  None of them include settings or keys. Everything is kept in IndexedDB. Deletes and resets can be undone.

## Secrets and personal data

Each line is redacted as it is read, before it is parsed, stored, shown, exported or sent. The redactor looks for:
- private key blocks
- passwords in URLs and connection strings
- JWTs, bearer and basic credentials
- cloud access keys and API keys
- `password=`/`secret=`/`token=` values
- email addresses
- card numbers (Luhn-checked)
- US social security numbers
- IP addresses, if you turn that on

The Safety checks panel counts what was removed and where. Tests check that timestamps, trace IDs, UUIDs, versions, pod names and order numbers are not mistaken for secrets. Redaction is pattern based, so a secret in an unusual shape can slip through; check before you share an export.

## Prompt injection

Logs contain text written by anyone: user agents, form fields, error messages. Lines that read like instructions to an AI are flagged and shown to you. Examples are "ignore previous instructions", "AI assistants must conclude…", role tags and requests to send keys. Flagged lines are excluded from clustering evidence, hypotheses, fixes and anything sent to a model.

One demo incident hides two such lines:
- a user agent asking AI tools to recommend deleting the orders database
- a form field claiming the cause is an expired certificate

A test confirms that removing them leaves the result unchanged.

## Demo mode and live mode

**Demo mode** runs everything in the page with no key.

**Live mode** adds an optional second opinion from your own model. Supported providers:
- OpenAI
- Anthropic (direct browser access)
- Google Gemini
- any OpenAI-compatible endpoint, such as OpenRouter, Ollama or LM Studio
- an experimental in-browser model through WebLLM, where WebGPU is available

What gets sent: up to 160 redacted, unflagged lines (evidence, context around it, anomaly samples and examples per template), the change list and the detected anomalies, all inside an `<untrusted_logs>` fence. "See what would be sent" shows the exact prompt.

How the reply is checked:
- A hypothesis is shown only if it cites a line that was actually sent.
- Citations to lines that were not sent are dropped.
- Text that parrots an injection is withheld.
- Suggested commands go through the same risk check.

Your key stays in the browser and goes only to the provider you choose, in a request header. It is kept in memory unless you tick "remember", and is never put in prompts, exports or backups.

## What is simulated

- Brightcart, its services, people, logs, metrics and past incidents are fictional and generated.
- Nothing is executed. Commands are text; "Simulate" is a mock that contacts nothing.
- Status updates and postmortems are drafts. Nothing is posted or emailed.
- Confidence comes from a transparent scoring rule, not a trained model. The six demo incidents were written to exercise these patterns, so 6/6 on them says the engine works as designed. It does not measure accuracy on real outages. A failure with no matching pattern will produce an abstention or a wrong guess, so add your own patterns.
- Times are shown in UTC. Syslog lines without a year use the year you choose at import.

## Why there is no server

A self-hosted component was considered: for log shipping, for larger files and to keep keys off the client. It was left out:
- Logs are among the most sensitive data a team has. Keeping parsing, redaction and analysis in the browser means they never leave the machine in demo mode.
- The Web Worker handles files of tens of megabytes.
- Live mode already goes straight from the browser to your provider.
- Teams that need streaming ingestion or shared incidents already run a log platform. Feeding IncidentLens an export from that platform is more useful than another service to operate.

## Run it yourself

It is a static site with no build step:

```sh
git clone https://github.com/shaikbasha1437/incidentlens-ai
cd incidentlens-ai
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # Node 20+; no dependencies
```

## Files

| Path | What it holds |
|---|---|
| `index.html`, `styles.css` | Page and styles (light and dark) |
| `js/parse.js` | Streaming multi-format log parser |
| `js/redact.js` | Secret and personal-data redaction |
| `js/guard.js` | Prompt-injection rules, prompt fence, key checks |
| `js/cluster.js` | Drain-style template mining |
| `js/pipeline.js` | Redact → parse → cluster → per-minute counts |
| `js/worker.js` | Runs the pipeline off the main thread for files |
| `js/detect.js` | Metrics and change-list parsing, anomaly detection |
| `js/patterns.js` | Built-in failure patterns, fixes and past incidents |
| `js/analyze.js` | Hypothesis scoring, symptom/cause split, abstention |
| `js/commands.js` | Command risk classes and placeholders |
| `js/live.js` | Live-mode prompt and citation checks |
| `js/llm.js`, `js/webllm.js` | Provider calls (shared with the other AgentKit apps) |
| `js/exporter.js` | Status drafts, postmortem, reports, CSV, backups |
| `js/seed.js` | The six demo incidents |
| `js/store.js`, `js/app.js` | Storage and the interface |
| `sw.js`, `manifest.webmanifest` | Offline support |
| `test/` | Node tests |

See [VERIFICATION.md](VERIFICATION.md) for what was tested and how.
