import assert from 'node:assert/strict'
import test from 'node:test'

import { simulate } from '../src/index.mjs'

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

function scenario(due, expiry, quiet) {
  return {
    schemaVersion: 1,
    alerts: [{ fingerprint: 'synthetic-a', occurredAt: due, expiresAt: expiry, labels: { service: 'api' } }],
    routes: [{ match: {}, groupBy: ['service'], groupWindowMs: 0, quietHours: [quiet], escalations: [{ afterMs: 0, recipients: ['SYNTHETIC_TEAM'] }] }],
  }
}

function run(document, at = document.alerts[0].occurredAt, extra = {}) {
  return simulate({ scenarioBytes: encode(document), at, clock: () => 0, ...extra })
}

test('night-time escalation is suppressed in its IANA zone but the quiet end is ready', () => {
  const quiet = { timeZone: 'Asia/Kolkata', start: '22:00', end: '07:00' }
  const night = run(scenario('2026-09-20T18:00:00.000Z', '2026-09-20T19:00:00.000Z', quiet))
  assert.equal(night.status, 'pass')
  assert.deepEqual(night.decisions.map((decision) => decision.state), ['suppressed-quiet'])
  assert.deepEqual(night.notifications, [])
  const morning = run(scenario('2026-09-21T01:30:00.000Z', '2026-09-21T02:00:00.000Z', quiet))
  assert.equal(morning.status, 'pass')
  assert.equal(morning.decisions[0].state, 'ready')
  assert.equal(morning.notifications.length, 1)
})

test('expiry at the night escalation instant wins over quiet suppression', () => {
  const quiet = { timeZone: 'Asia/Kolkata', start: '22:00', end: '07:00' }
  const document = scenario('2026-09-20T17:00:00.000Z', '2026-09-20T18:00:00.000Z', quiet)
  document.routes[0].escalations[0].afterMs = 3_600_000
  const report = run(document, '2026-09-20T18:00:00.000Z')
  assert.equal(report.status, 'pass')
  assert.equal(report.decisions[0].state, 'expired')
  assert.deepEqual(report.notifications, [])
})

test('spring DST skip uses the actual local minute on each UTC instant', () => {
  const quiet = { timeZone: 'America/New_York', start: '01:30', end: '03:30' }
  const inWindow = run(scenario('2026-03-08T07:00:00.000Z', '2026-03-08T08:00:00.000Z', quiet))
  assert.equal(inWindow.decisions[0].state, 'suppressed-quiet')
  const atEnd = run(scenario('2026-03-08T07:30:00.000Z', '2026-03-08T08:00:00.000Z', quiet))
  assert.equal(atEnd.decisions[0].state, 'ready')
})

test('both repeated fall DST minutes obey the same quiet-hour rule', () => {
  const quiet = { timeZone: 'America/New_York', start: '01:30', end: '02:00' }
  for (const due of ['2026-11-01T05:45:00.000Z', '2026-11-01T06:45:00.000Z']) {
    const report = run(scenario(due, '2026-11-01T08:00:00.000Z', quiet))
    assert.equal(report.status, 'pass')
    assert.equal(report.decisions[0].state, 'suppressed-quiet')
  }
})

test('a timezone conversion failure is incomplete, not silently non-quiet', () => {
  const quiet = { timeZone: 'Asia/Kolkata', start: '22:00', end: '07:00' }
  const original = Intl.DateTimeFormat.prototype.formatToParts
  Intl.DateTimeFormat.prototype.formatToParts = () => { throw new RangeError('synthetic conversion failure') }
  try {
    const report = run(scenario('2026-09-20T18:00:00.000Z', '2026-09-20T19:00:00.000Z', quiet))
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'timezone-conversion-failed'))
    assert.deepEqual(report.notifications, [])
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original
  }
})

test('a later quiet window conversion failure is incomplete even if an earlier window suppresses', () => {
  const document = scenario('2026-09-20T18:00:00.000Z', '2026-09-20T19:00:00.000Z',
    { timeZone: 'Asia/Kolkata', start: '22:00', end: '07:00' })
  document.routes[0].quietHours.push({ timeZone: 'UTC', start: '00:00', end: '01:00' })
  const original = Intl.DateTimeFormat.prototype.formatToParts
  let reads = 0
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) {
    reads += 1
    if (reads === 2) throw new RangeError('synthetic second-window conversion failure')
    return original.apply(this, args)
  }
  try {
    const report = run(document)
    assert.equal(reads, 2)
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'timezone-conversion-failed'))
    assert.deepEqual(report.notifications, [])
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original
  }
})

test('injected elapsed timeout stays silent at N and fires at N+1', () => {
  const quiet = { timeZone: 'UTC', start: '22:00', end: '07:00' }
  const document = scenario('2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z', quiet)
  const clock = (later) => { let reads = 0; return () => reads++ === 0 ? 0 : later }
  assert.equal(run(document, undefined, { limits: { maxMillis: 5 }, clock: clock(5) }).status, 'pass')
  const over = run(document, undefined, { limits: { maxMillis: 5 }, clock: clock(6) })
  assert.equal(over.status, 'incomplete')
  assert.ok(over.findings.some((finding) => finding.ruleId === 'simulation-timeout'))
  assert.deepEqual(over.notifications, [])
})

test('an invalid or backwards injected elapsed clock cannot produce a pass', () => {
  const quiet = { timeZone: 'UTC', start: '22:00', end: '07:00' }
  const document = scenario('2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z', quiet)
  for (const later of [NaN, Infinity, -1]) {
    let reads = 0
    const report = run(document, undefined, { clock: () => reads++ === 0 ? 0 : later })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.notifications, [])
  }
})

test('a failed first clock tick is clock-invalid incomplete without leaking its exception', () => {
  const quiet = { timeZone: 'UTC', start: '22:00', end: '07:00' }
  const document = scenario('2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z', quiet)
  const good = run(document, undefined, { clock: () => 0 })
  assert.equal(good.status, 'pass')
  assert.equal(good.summary.checked, 1)
  for (const clock of [
    () => { throw new Error('SYNTHETIC_CLOCK_CANARY') },
    () => NaN,
    () => Infinity,
    () => '0',
  ]) {
    const report = run(document, undefined, { clock })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(report.decisions, [])
    assert.deepEqual(report.notifications, [])
    assert.deepEqual(report.findings.map((entry) => [entry.ruleId, entry.severity]), [['clock-invalid', 'error']])
    assert.equal(JSON.stringify(report).includes('SYNTHETIC_CLOCK_CANARY'), false)
  }
})
