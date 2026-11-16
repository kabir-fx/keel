---
name: observability
description: Make running software explain itself with structured logs, metrics, traces, and alerts that lead to action. Use when adding logging, metrics, tracing, or alerting, when a production problem could not be diagnosed from the existing signals, or when preparing a service for release.
argument-hint: "[the code, or the question you could not answer]"
---

# Observability

Instrumentation is done when someone who did not write the code can answer "is it working, and if not, where is it broken?" without reading the code.

## 1. Questions first

Write the three to five questions someone will ask about this code at the worst moment: "Did the export finish? How long did it take? Which step failed, and for whom?" Every signal you add answers one of them. A signal that answers none is noise: leave it out.

## 2. Pick the signal by the question

| Question | Signal |
|---|---|
| What happened to this one request or job? | a structured log line, or a trace |
| How often, how many, how fast, across all of them? | a metric |
| Where did the time go across components? | a trace |
| Should a human be interrupted? | an alert on a metric |

Use what the repo already has before adding a library. For a CLI or a library, one good structured log and clear exit codes may be all it needs.

## 3. Logs

- Structured (JSON or key-value), one event per line, with fixed field names. Not sentences with values glued in.
- Every line carries a correlation id (a request, job, or run id) and enough context to stand alone.
- Log at the boundaries: a request arrives, a call leaves, a job changes state, a decision goes one way. Not inside loops.
- Levels mean something: `error` needs a human, `warn` is unexpected but handled, `info` is a normal state change, `debug` is off in production.
- Log an error once, where it is handled, with its cause chain. Not at every layer it passes through.
- Never log secrets, tokens, passwords, or personal data. Log the id, not the record.

## 4. Metrics

- For anything that serves requests: rate, errors, duration. For a resource: utilisation, saturation, errors.
- Record durations as histograms, so percentiles work. An average hides the slow tail.
- Labels take few, bounded values: a route, a status class, a region. Never a user id, an email, a URL with ids in it, or an error message, because each new value creates a new time series.
- Put the unit in the name: `_seconds`, `_bytes`, `_total`.

## 5. Traces

Use OpenTelemetry unless the repo already has a tracer. One span per meaningful unit of work, with context passed across every process and queue boundary. Put the correlation id from the logs on the span, so each leads to the other.

## 6. Alerts

- Alert on symptoms a user feels (errors, slowness, the job that did not run), not on causes (high CPU).
- Every alert says what is wrong, links a runbook, and needs an action. An alert nobody acts on gets deleted.
- The runbook says what the alert means, how to confirm it, the first three things to check, how to mitigate, and who to escalate to.

## 7. Do no harm

Telemetry must never break or slow the thing it watches. Emit cheaply or asynchronously, bound the buffers, and swallow telemetry failures. This is one of the few legitimate swallowed errors: say so in a comment.

## 8. Prove it

Cause the failure on purpose, in a test or a local run. Then answer each question from step 1 using only the signals. A question you cannot answer means the instrumentation is not done. Show the log lines and the metric values you used.
