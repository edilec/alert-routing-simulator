# Alert Routing Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report the intended route, group, escalation, and quiet-hour decisions for a saved alert scenario without contacting recipients.

**Architecture:** A strict JSON reader and scenario validator produce an all-or-nothing usable model. A pure simulator sorts saved alerts, forms route groups, and evaluates levels at an injected UTC cutoff. An offline CLI confines the input to a declared root and optionally writes the byte-identical JSON report through the catalog guard.

**Tech Stack:** Node ESM standard library, `node:test`, `node:assert/strict`; no dependencies, browser, network, live clock, or provider.

**Spec:** [Alert Routing Simulator design](../../alert-routing-design.md)

## Global constraints

- Keep existing Git history and use local commits only; do not touch central ledgers or receipts.
- No network operation, listener, notification send, real person/credential fixture, or AI attribution.
- Every report follows house envelope, severity, incomplete, path, determinism, bounds, and exit-shape rules.
- Use UTC canonical instants, explicit IANA zones only for local quiet-hour conversion, and UTF-16 code-unit sorting.
- Write tests first, observe each named test red, and prove README guarantees fail when removed.

## Files and interfaces

- `src/json.mjs`: `parseUniqueJson(bytes, limits)`; fatal UTF-8 decode, duplicate-key and unsafe-number refusal, depth/byte bounds. Returns a document or a coded evidence error.
- `src/model.mjs`: `validateScenario(document, limits)`; validates every alert and route before simulation, returns a normalized model or located problems. `parseInstant` accepts only canonical UTC milliseconds.
- `src/index.mjs`: exports `TOOL_ID`, `RULE_SEVERITY`, `simulate({scenarioBytes, at, limits, clock, source})`; returns a report with `decisions` and `notifications`.
- `src/write-guard.mjs`: copy the central destination guard unchanged and test its actual write-path use.
- `bin/alert-routing-simulator.mjs`: `--root`, `--scenario`, `--at`, optional `--report`, `--json`, `--help`, known bound overrides.
- `test/*.test.mjs`: real library and CLI controls; synthetic data only; no listener or network call.
- `README.md`, `examples/`: public profile, runnable pass/fail samples, rule table, limits, exit codes, non-goals.

### Task 1: Strict evidence and complete policy validation

- [ ] Write `test/model.test.mjs` first. The first good test passes a scenario with one alert, one default route, and one level at an explicit UTC cutoff; assert `pass`, `checked: 1`, and no findings. Named negative tests refuse duplicate JSON keys, invalid UTF-8, unknown properties, bad timezone, missing groupBy label, malformed timestamps, and exact-N/N+1 byte/depth/alert/route/level bounds. The malformed policy must produce `incomplete`, no `unrouted-alert`, and no notification.
- [ ] Run `node --test test/model.test.mjs` and observe good and negative cases red because no implementation exists.
- [ ] Implement `src/json.mjs` and `src/model.mjs` with the documented profile. Reuse no runtime package. All validation is completed before a route index is used. In `src/index.mjs`, establish one frozen severity table and an incomplete report branch.
- [ ] Run the focused test to green. Prove the unknown-rule and N/N+1 assertions fail if their guards are temporarily removed, then restore.
- [ ] Commit the evidence-validation slice after its tests are green.

The first test's concrete input is:

```js
const bytes = new TextEncoder().encode(JSON.stringify({
  schemaVersion: 1,
  alerts: [{ fingerprint: 'a', occurredAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-20T11:00:00.000Z', labels: { service: 'api' } }],
  routes: [{ match: {}, groupBy: ['service'], groupWindowMs: 60000, quietHours: [], escalations: [{ afterMs: 0, recipients: ['SYNTHETIC_TEAM_A'] }] }],
}))
const report = simulate({ scenarioBytes: bytes, at: '2026-09-20T10:00:00.000Z', clock: () => 0 })
assert.equal(report.status, 'pass')
assert.equal(report.summary.checked, 1)
```

### Task 2: Group, dedupe, escalation, expiry

- [ ] Write `test/simulation.test.mjs` with a matching alert as the no-finding control. Add two same-fingerprint alerts inside a fixed window and assert one active identity/one intent; a distinct fingerprint joins the same group; at N milliseconds a later alert joins and at N+1 starts a new group. Levels are due from group start, not previous firing. At `due === expiresAt` the decision is `expired`; at one millisecond before it is `ready`. A valid unmatched alert yields `fail` and `unrouted-alert`.
- [ ] Run focused tests red, implement route matching, stable grouping, active-fingerprint dedupe, decisions and notification projection in `src/index.mjs`, then run green. Sort by UTC instant, source index, route index, group index, level index; compare untrusted keys only by code unit.
- [ ] Temporarily remove one dedupe/expiry/group boundary guard at a time and observe its named test fail, restore, then commit.

### Task 3: Timezone and virtual-time quiet decisions

- [ ] Write `test/time.test.mjs` for a quiet-hour UTC-to-Asia/Kolkata night, out-of-quiet good control, exclusive expiry, pending level beyond `at`, New York spring skip and repeated fall hour, and unsupported timezone/conversion failure. Every failure path must remain incomplete rather than pretending non-quiet. Add a deterministic injected elapsed-clock timeout test at N/N+1.
- [ ] Run red; implement timezone validation and local-minute conversion with built-in `Intl.DateTimeFormat` only, no collation, and timeout checks at actual work boundaries. Run focused green.
- [ ] Remove the quiet decision or incomplete timeout marker temporarily, observe its test fail, restore, and commit.

### Task 4: Offline CLI, guards, docs and release checks

- [ ] Write `test/cli.test.mjs` first for `--help` exit 0; clean stdout JSON plus fixed human stderr; `--json` suppressing only summary; invalid config exit 2/empty stdout; unreadable scenario exit 2/incomplete report; known policy gap exit 1; safe root `/` and symlink escape; safe `--report` byte equality; destination symlink, symlinked parent, hard-link input, dangling input symlink alias refusals that preserve input bytes; and a true no-network runtime/source gate with a safe `data:` denial control.
- [ ] Run red; implement CLI with bounded reads and realpath confinement, copy the central `assertWritableDestination`, and pass every named input path to it. Write refusal returns incomplete on stdout with no notification intents. Run focused green and remove the guard temporarily to prove attack tests bite.
- [ ] Replace scaffold README with quick start, exact schema, route/quiet/expiry rules, rule table, limits, exit codes, input/output safety and non-goals. Add runnable clean and failing examples. Set `0.1.0` and `lint`, `test`, `check` scripts; include every new source/test file in lint.
- [ ] Inspect the final diff and raw source bytes (no literal U+2028/U+2029/NUL), run `npm run check`, drive both examples, confirm `git status --short` clean after a local commit. Report only measured facts for the independent reviewer; do not write a receipt.
