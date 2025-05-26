# Alert Routing Simulator

Verify a saved alert policy before trusting its grouping, escalation, and quiet
hours. This is a reporter, not an alerting service: it never sends a message,
resolves a recipient, opens a socket, or reads a live provider. It evaluates a
deliberately narrow JSON scenario using an explicit virtual UTC cutoff.

## Quick start

Requires Node 22 or newer; there are no dependencies.

```sh
npm run check
node bin/alert-routing-simulator.mjs --root . --scenario examples/scenario-pass.json --at 2026-09-20T10:00:30.000Z
node bin/alert-routing-simulator.mjs --root . --scenario examples/scenario-fail.json --at 2026-09-20T10:00:30.000Z --json
```

The first command exits 0. The failing example exits 1 with `unrouted-alert`.
Both print one machine-readable JSON report to stdout. Without `--json`, a
fixed human summary goes to stderr; `--json` suppresses that summary, not
configuration diagnostics. `--help` displays the CLI flags without reading or
writing a scenario.

## Saved scenario profile

The CLI requires `--root DIR`, `--scenario FILE`, and `--at UTC`. `--at`,
`occurredAt`, and `expiresAt` use canonical UTC milliseconds such as
`2026-09-20T10:00:00.000Z`. The library exports `simulate({scenarioBytes, at,
limits, clock, source})` and `TOOL_ID = 'alert-routing-simulator'`. The virtual
cutoff is required in both entry points; no current date is silently read.

```json
{
  "schemaVersion": 1,
  "alerts": [
    {
      "fingerprint": "synthetic-a",
      "occurredAt": "2026-09-20T10:00:00.000Z",
      "expiresAt": "2026-09-20T11:00:00.000Z",
      "labels": { "service": "api", "severity": "critical" }
    }
  ],
  "routes": [
    {
      "match": { "severity": "critical" },
      "groupBy": ["service"],
      "groupWindowMs": 60000,
      "quietHours": [{ "timeZone": "Asia/Kolkata", "start": "22:00", "end": "07:00" }],
      "escalations": [{ "afterMs": 0, "recipients": ["SYNTHETIC_TEAM"] }]
    }
  ]
}
```

Unknown fields, duplicate JSON object keys, invalid UTF-8, imprecise numbers,
invalid timestamps, and unavailable grouping labels make the whole simulation
`incomplete`. A malformed route is never dropped to make an alert look
unrouted. Identifiers are nonempty, visible strings of at most 256 UTF-16
units, with no leading/trailing whitespace, control, or default-ignorable
characters. The `quietHours` array may be omitted; when present, each window
needs a valid IANA timezone and distinct `HH:mm` endpoints. Alert expiry must
be later than occurrence. Escalation offsets are nonnegative, increasing safe
integers; every level has at least one unique recipient ID.

## Simulation rules

| Rule | Exact behavior |
| --- | --- |
| Route | First exact label-map match in document order wins; an empty `match` is a default route. A fully evaluated unmatched alert fails. |
| Group | Same route and exact `groupBy` values share a fixed window anchored to its first alert. At `groupWindowMs` the later alert joins; at N+1 it starts a new group. |
| Duplicate | The same fingerprint counts once among active alerts in a group, although a later occurrence may extend its active lifetime. Distinct fingerprints may share one intent. |
| Escalation | Level due time is group start plus its `afterMs`; it is never based on a prior level firing. Levels beyond `--at` are pending. |
| Expiry | At a due instant, an occurrence is active only if `occurredAt <= due < expiresAt`. Equality with expiry is expired. Expiry is checked before quiet hours. |
| Quiet hours | Local interval is start-inclusive/end-exclusive, including an overnight interval. A due intent inside is `suppressed-quiet`, not deferred; outside is `ready`. DST skipped times never occur and repeated local minutes both follow the window. |
| Output | `decisions` shows each evaluated group/level; `notifications` contains only `ready` intended notifications. Source pointers and counts locate alerts/recipients; raw fingerprints, labels and recipient IDs are never echoed. Nothing is sent. |

`status: pass` means the saved scenario was fully evaluated without a known
route gap. It is **not** a delivery claim, and it can include visible pending,
expired, or quiet-suppressed decisions. `summary.checked` counts alerts at or
before the virtual cutoff. A scenario with none is incomplete, not a vacuous
pass. Findings and decisions are deterministic: source order and UTF-16 code
unit comparison are used, never locale collation. The installed Node/ICU
timezone database affects IANA conversion and should be pinned for byte-exact
cross-machine comparisons.
All declared quiet windows are converted before a suppression decision is
finalized; a conversion failure in a later window makes the run incomplete.

## Report rules and exits

The report has `schemaVersion: "1"`, `tool`, `status`, `summary`, `findings`,
`decisions`, and `notifications`. Each finding has a stable rule ID, frozen
severity, bounded generic message and a relative source file/JSON pointer.
There are no raw recipient addresses or secret-bearing alert excerpts.

| Rule ID | Severity | Meaning |
| --- | --- | --- |
| `unrouted-alert` | error | A valid alert matches no valid route; complete check fails. |
| `no-alerts` | error | No alert was available by the virtual cutoff. |
| `scenario-invalid`, `scenario-duplicate-key`, `numeric-precision` | error | Input shape, duplicate object key, or numeric value cannot be trusted. |
| `scenario-unreadable`, `input-unreadable`, `input-outside-root`, `invalid-utf8`, `malformed-json` | error | Required input could not be obtained or parsed under the declared root. |
| `byte-limit`, `depth-limit`, `alert-limit`, `route-limit`, `level-limit` | error | A documented input or model bound was exceeded. |
| `timezone-unsupported`, `timezone-conversion-failed`, `time-overflow` | error | A due instant or its local-zone interpretation cannot be evaluated. |
| `clock-invalid`, `simulation-timeout` | error | The injected elapsed clock or work budget prevented a complete run. |
| `output-refused`, `output-unwritable` | error | The optional report destination was unsafe or could not be written. |

All rules except `unrouted-alert` make status `incomplete`; known route gaps
make status `fail`. Exit 0 means complete/pass, exit 1 complete/fail, exit 2
incomplete or invalid configuration. Invalid CLI/options/root/limit/`--at`
produce exit 2 with **empty stdout** and a fixed stderr diagnostic. A named
input that cannot be read produces exit 2 with an **incomplete JSON report**
on stdout. A destination refusal also produces an incomplete report, with no
notification intents. A normal run prints JSON and never appends prose to
stdout.

## Limits and output safety

| CLI flag | Default | Boundary |
| --- | ---: | --- |
| `--max-bytes` | 1048576 | Input byte length at N is accepted; N+1 is incomplete. |
| `--max-alerts` | 1000 | Maximum alert entries. |
| `--max-routes` | 100 | Maximum route entries. |
| `--max-levels` | 16 | Maximum escalation levels per route. |
| `--max-depth` | 16 | JSON root is depth 0 and child values add one. |
| `--max-millis` | 5000 | Elapsed work clock; exactly N is allowed, over N incomplete. |

The elapsed clock is injected in the library (default `performance.now`) and
never used as the virtual alert time. Unknown or invalid limit names/values
are invalid configuration, not silently ignored.

Optional `--report FILE` writes the same JSON bytes printed to stdout. A
successful destination is inside the real `--root` and may be an existing
regular file explicitly named by the caller. The guard refuses a destination
symlink, parent symlink escaping the root, a hard link or direct alias to the
scenario input, and an absent destination named by a dangling input symlink.
The named and resolved input paths are both protected. A write failure is
incomplete and never claims an intent was written successfully. A symlinked
input leaving the real root is not read or credited as in-root evidence.
Finding file labels refer to the named path relative to `--root`, not its
resolved symlink target. Characters outside safe ASCII letters, digits,
`.`, `_`, `-`, and `/` are escaped as `%XXXX` UTF-16 code units (including
literal `%`). This keeps distinct control-bearing filenames distinct without
printing a raw control or absolute host path.

## Non-goals

This is not an Alertmanager parser, notification sender, retry engine,
provider adapter, recipient validator, browser driver, or auto-fixer. It does
not infer missing alerts or fetch a live policy. The scenario profile is
independent and intentionally small.
