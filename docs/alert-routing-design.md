# Alert Routing Simulator design

## Purpose and authority

The tool replays a saved, synthetic alert scenario against saved routing rules.
It reports what notifications the rules would intend; it never sends, resolves,
or connects to a recipient. No live browser, clock, provider, or network input is
part of the simulation. Its only time authorities are the caller's UTC cutoff
and the UTC timestamps in the document.

## Scenario profile

One JSON document has `schemaVersion: 1`, `alerts`, and `routes`. Unknown fields
or unsupported values make the entire run incomplete; the simulator does not
discard a bad rule and then claim an alert is unrouted. Every alert has a
nonempty `fingerprint`, a canonical UTC `occurredAt`, a canonical UTC
`expiresAt` later than `occurredAt`, and a `labels` object of bounded visible
strings. A route has an exact-equality `match` label map, ordered `groupBy`
label names, integer `groupWindowMs`, optional `quietHours`, and nonempty
`escalations`. Each escalation has a nonnegative integer `afterMs` and a
nonempty `recipients` array of opaque IDs. Escalation offsets increase strictly.
Every label named by a matched route's `groupBy` must be present on that alert;
missing grouping evidence makes the scenario incomplete rather than silently
placing unrelated alerts into one group.

UTC instants use `YYYY-MM-DDTHH:mm:ss.sssZ` exactly. The CLI takes a separate
`--at` instant in that format. The library requires the same injected cutoff;
neither entry point defaults to the current date. A monotonic elapsed-time
clock, injected in library options with a documented `performance.now` default,
enforces the work timeout but never appears in output.

The first matching route in document order owns an alert. A missing label does
not match. A fully valid alert with no route yields an `unrouted-alert` error;
the overall result is `fail`. Before routing, all rules and alerts are
validated. If any are unparseable or unsupported, status is `incomplete` and
there is no route/absence claim from partial evidence.

For each route, alerts are ordered by `(occurredAt, source index)`. A group is
identified by the route and the exact `groupBy` label values, with a fixed
window anchored at its first alert. A later alert joins while its timestamp
minus the group start is at most `groupWindowMs`; at N+1 milliseconds it starts
a new group. Alerts with the same fingerprint inside one group are duplicates:
they count once in that group's active alert count, but later occurrences may
extend the time that fingerprint remains active. Distinct fingerprints may
share one grouped notification.

Each escalation is due at `group start + afterMs`, not after a prior level
fires. At a due instant, a fingerprint is active if at least one occurrence
within the group has `occurredAt <= due < expiresAt`. Equality with expiry
is expired. If due is later than `--at`, the decision is `pending`. Otherwise,
no active fingerprints is `expired`; an active group in quiet hours is
`suppressed-quiet`; an active group outside quiet hours is `ready` and yields
one intended notification. These are decisions about a saved scenario, not
evidence of delivery.

Each quiet-hour entry has an IANA `timeZone`, `start` and `end` in 24-hour
`HH:mm` local time; equal endpoints are invalid. The interval is start-
inclusive and end-exclusive; an end earlier than start crosses midnight.
At each UTC due instant, built-in `Intl.DateTimeFormat` converts it to the
zone's local minute. DST skipped local times never occur; repeated local
minutes follow the same rule on both UTC occurrences. The installed Node/ICU
timezone database is therefore part of reproducibility; no collation or
locale-dependent sorting is used.

## Report and CLI

The report uses house envelope version `"1"` and `TOOL_ID`. `summary.checked`
counts fully evaluated alerts. `decisions` lists each group/level with route,
level, and alert source pointers, due UTC instant, active distinct-alert count,
and one of `pending`, `expired`, `suppressed-quiet`, `ready`. `notifications`
contains only `ready` decisions, with recipient source pointers and counts.
Raw alert labels, fingerprints, route predicates, and recipient IDs never
appear in the report or human summary. Source pointers and group ordinals are
the locators. Findings use a frozen rule/severity table, stable code-unit
sorting, bounded generic evidence, and a path relative to the declared root.
`pass` requires at least one checked alert and no errors/unknown evidence.

The CLI requires `--root DIR --scenario FILE --at UTC`. It accepts `--json`,
`--help`, documented limit overrides, and optional `--report FILE`. Stdout
always contains JSON on a completed or incomplete input run; by default a
brief human summary goes to stderr, while `--json` suppresses only that
summary. Invalid CLI/configuration has exit 2, empty stdout, and a fixed
diagnostic. Unreadable or invalid input has exit 2 and an incomplete report.
Valid policy gaps exit 1. A safe existing report file may be overwritten only
when named explicitly. The copied destination guard refuses a symlink at the
destination, a symlinked-parent escape, hard-link alias to every named input,
and dangling input-symlink aliases. Write refusal/failure yields exit 2 plus
an incomplete report on stdout, never a success claim. Successful file bytes
equal stdout bytes. The scenario read resolves the real path under the real
root; out-of-root evidence is never presented as in-root.

## Bounds and verification

Default finite limits are `maxBytes: 1048576`, `maxAlerts: 1000`,
`maxRoutes: 100`, `maxLevels: 16` per route, `maxDepth: 16`, and
`maxMillis: 5000`. Every configurable limit has an exact-N
good control and N+1 incomplete control; malformed/unknown limit options are
invalid configuration. The timeout uses an injected clock and a deterministic
test sequence. Tests first prove a correct route is silent, then prove group
boundary, deduplication, expiry boundary, cross-midnight quiet hours, spring
and fall DST, unknown rules on both sides of routing, non-contact with
recipients, all three exit shapes, path confinement, and output-alias guards.
Every README guarantee is pinned by a test observed failing when its behavior
is removed.

## Non-goals

No Alertmanager-compatible parser, live alert intake, notification delivery,
retry queue, provider lookup, recipient validation, or auto-correction. The
saved schema is a deliberately narrow simulator profile, not a claim to
implement any upstream alerting product.
