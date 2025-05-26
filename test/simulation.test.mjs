import assert from 'node:assert/strict'
import test from 'node:test'

import { compareCodeUnits, simulate } from '../src/index.mjs'

const START = '2026-09-20T10:00:00.000Z'
const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const time = (milliseconds) => new Date(Date.parse(START) + milliseconds).toISOString()

function scenario() {
  return {
    schemaVersion: 1,
    alerts: [{ fingerprint: 'SYNTHETIC_FINGERPRINT', occurredAt: START, expiresAt: time(120_000), labels: { service: 'api', severity: 'critical' } }],
    routes: [{ match: { severity: 'critical' }, groupBy: ['service'], groupWindowMs: 60_000, quietHours: [], escalations: [{ afterMs: 0, recipients: ['SYNTHETIC_PRIMARY'] }] }],
  }
}

function run(document, at = START) {
  return simulate({ scenarioBytes: encode(document), at, clock: () => 0 })
}

test('duplicate fingerprints within a fixed group count once at every level', () => {
  const document = scenario()
  document.alerts.push({ ...document.alerts[0], occurredAt: time(30_000) })
  document.routes[0].escalations.push({ afterMs: 30_000, recipients: ['SYNTHETIC_BACKUP'] })
  const report = run(document, time(30_000))
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.groups, 1)
  assert.equal(report.notifications.length, 2)
  assert.deepEqual(report.decisions.map((decision) => decision.activeAlerts), [1, 1])
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_FINGERPRINT'), false)
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_PRIMARY'), false)
})

test('distinct fingerprints share one group but count as two at a later escalation', () => {
  const document = scenario()
  document.alerts.push({ ...document.alerts[0], fingerprint: 'SECOND', occurredAt: time(10_000) })
  document.routes[0].escalations.push({ afterMs: 20_000, recipients: ['SYNTHETIC_BACKUP'] })
  const report = run(document, time(20_000))
  assert.equal(report.summary.groups, 1)
  assert.equal(report.notifications.length, 2)
  assert.deepEqual(report.decisions.map((decision) => decision.activeAlerts), [1, 2])
  assert.deepEqual(report.decisions.map((decision) => decision.dueAt), [START, time(20_000)])
})

test('a group window includes exactly N milliseconds and splits at N+1', () => {
  const atBoundary = scenario()
  atBoundary.alerts.push({ ...atBoundary.alerts[0], fingerprint: 'SECOND', occurredAt: time(60_000) })
  const exact = run(atBoundary, time(60_001))
  assert.equal(exact.summary.groups, 1)
  assert.equal(exact.notifications.length, 1)

  const overBoundary = scenario()
  overBoundary.alerts.push({ ...overBoundary.alerts[0], fingerprint: 'SECOND', occurredAt: time(60_001) })
  const beyond = run(overBoundary, time(60_001))
  assert.equal(beyond.summary.groups, 2)
  assert.equal(beyond.notifications.length, 2)
})

test('expiry is exclusive: ready at expiry minus one millisecond, expired at equality', () => {
  const document = scenario()
  document.alerts[0].expiresAt = time(10)
  document.routes[0].escalations = [
    { afterMs: 9, recipients: ['SYNTHETIC_PRIMARY'] },
    { afterMs: 10, recipients: ['SYNTHETIC_BACKUP'] },
  ]
  const report = run(document, time(10))
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.decisions.map((decision) => decision.state), ['ready', 'expired'])
  assert.equal(report.notifications.length, 1)
})

test('an escalation beyond the injected cutoff is pending, not already delivered', () => {
  const document = scenario()
  document.routes[0].escalations = [{ afterMs: 1, recipients: ['SYNTHETIC_PRIMARY'] }]
  const report = run(document)
  assert.equal(report.status, 'pass')
  assert.equal(report.decisions[0].state, 'pending')
  assert.deepEqual(report.notifications, [])
})

test('a fully evaluated unmatched alert fails at its source position', () => {
  const document = scenario()
  document.alerts[0].labels.severity = 'warning'
  const report = run(document)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.checked, 1)
  assert.deepEqual(report.findings.map((finding) => [finding.ruleId, finding.location.pointer]), [['unrouted-alert', '/alerts/0']])
})

test('multiple finding locations sort by UTF-16 code unit, not locale collation', () => {
  assert.equal(compareCodeUnits('Z', 'a'), -1)
  assert.equal(compareCodeUnits('a', 'Z'), 1)
  assert.equal(compareCodeUnits('same', 'same'), 0)
  const document = scenario()
  document.alerts = Array.from({ length: 11 }, (_, index) => ({
    ...document.alerts[0], fingerprint: `synthetic-${index}`, labels: { severity: 'warning', service: 'api' },
  }))
  const report = run(document)
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map((entry) => entry.location.pointer),
    ['/alerts/0', '/alerts/1', '/alerts/10', '/alerts/2', '/alerts/3', '/alerts/4', '/alerts/5', '/alerts/6', '/alerts/7', '/alerts/8', '/alerts/9'])
})

test('first matching route wins without exposing its label values or recipients', () => {
  const document = scenario()
  document.routes.push({ ...structuredClone(document.routes[0]), escalations: [{ afterMs: 0, recipients: ['SYNTHETIC_OTHER'] }] })
  const report = run(document)
  assert.equal(report.status, 'pass')
  assert.equal(report.notifications[0].routePointer, '/routes/0')
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_OTHER'), false)
})
