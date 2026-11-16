---
name: perf
description: Measure and improve performance without fooling yourself. Use when something is slow, when benchmarking or profiling, when asked to optimise speed, memory, or cost, or before reporting any performance number.
argument-hint: "[what is slow, or the number to check]"
---

# Perf

A performance number is a claim, and most wrong ones come from measuring the wrong thing. Never optimise before measuring. Never report a number you did not save.

## Before measuring

Write the claim under test and what counts as success: the metric, the unit, the workload, the target. "p95 latency of `search()` under 200 ms on the 60k-row fixture, on this machine." If the target is undecided, that is my call: ask.

## The loop

1. **Baseline.** Measure the current state on a realistic workload, several runs. Record the median, the spread, the machine, the commit, and the exact command. Save the raw output to a file.
2. **Find the limiter.** Profile. The cause is rarely where intuition points. Name what bounds the number: CPU, memory, I/O, the network, a lock, an external service.
3. **Try the cheapest idea first**, in this order: do not do the work, do it once (cache or hoist), do it less often (batch), do it cheaper (a better algorithm or data structure), do it later (defer), do it in parallel.
4. **One change, one measurement.** Same command, same machine, same workload. Keep the change or revert it. A gain inside the run-to-run spread is not a gain.
5. Stop when the target is met. Do not polish past it.

## Vet the number

Before reporting any result, answer each of these in a line.

1. **Why is it not double?** Name what limits the number. If you cannot, you do not understand the result yet.
2. **Was the baseline tuned as hard as the new version?** Same flags, same warm-up, same effort.
3. **Is it measuring what you think?** Check that a cache is not serving the answer, the work is not skipped or optimised away, and the timer covers the whole operation.
4. **Is the work still correct?** Check the output and the error count. A fast failure is not a speed-up.
5. **Does it reproduce?** Run it again, ideally from a cold start. Report the range, not the best run.
6. **Does it matter to the user?** Tie it to something they would notice, or to cost.
7. **Did the thing happen at all?** Confirm the code path under test ran: a count, a log line, a profile.

## Report

Verdict first. Then the number with its unit, the run count, the range, the workload, the machine, the limiter, the command to reproduce, and the path to the saved raw output. Label anything not measured as `inferred` or `guess` (rule 5). No saved result, no number.

A performance fix lands with a guard where the repo can hold one: a benchmark in CI, or a limit in `QUALITY.md`.
