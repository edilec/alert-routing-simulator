import assert from 'node:assert/strict'
import test from 'node:test'

import { simulate } from '../src/index.mjs'

const AT = '2026-09-20T10:00:00.000Z'
const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

function goodScenario() {
  return {
    schemaVersion: 1,
    alerts: [{ fingerprint: 'alert-a', occurredAt: AT, expiresAt: '2026-09-20T11:00:00.000Z', labels: { service: 'api' } }],
    routes: [{ match: {}, groupBy: ['service'], groupWindowMs: 60_000, quietHours: [], escalations: [{ afterMs: 0, recipients: ['SYNTHETIC_TEAM_A'] }] }],
  }
}

function run(document, options = {}) {
  return simulate({ scenarioBytes: encode(document), at: AT, clock: () => 0, ...options })
}

test('a complete matching alert routes without a false finding', () => {
  const report = run(goodScenario())
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.deepEqual(report.findings, [])
  assert.equal(report.notifications.length, 1)
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_TEAM_A'), false)
})

test('an unevaluable route invalidates the whole comparison, not a false unrouted alert', () => {
  const document = goodScenario()
  document.routes[0].unsupported = true
  const report = run(document)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'scenario-invalid'))
  assert.equal(report.findings.some((finding) => finding.ruleId === 'unrouted-alert'), false)
  assert.deepEqual(report.notifications, [])
})

test('a matched route with missing groupBy evidence is incomplete', () => {
  const document = goodScenario()
  document.routes[0].groupBy = ['region']
  const report = run(document)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'unrouted-alert'), false)
  assert.deepEqual(report.notifications, [])
})

test('duplicate JSON keys are refused before parse can erase them', () => {
  const text = JSON.stringify(goodScenario()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')
  const report = simulate({ scenarioBytes: new TextEncoder().encode(text), at: AT, clock: () => 0 })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'scenario-duplicate-key'))
})

test('rounded numeric evidence is incomplete while exact equivalent decimal evidence passes', () => {
  const text = JSON.stringify(goodScenario())
  const exact = text.replace('"groupWindowMs":60000', '"groupWindowMs":60000.0')
  const rounded = text.replace('"groupWindowMs":60000', '"groupWindowMs":60000.000000000000001')
  const runBytes = (value) => simulate({ scenarioBytes: new TextEncoder().encode(value), at: AT, clock: () => 0 })
  assert.equal(runBytes(exact).status, 'pass')
  const refused = runBytes(rounded)
  assert.equal(refused.status, 'incomplete')
  assert.ok(refused.findings.some((entry) => entry.ruleId === 'numeric-precision'))
})

test('an invalid IANA timezone is incomplete, never a non-quiet assumption', () => {
  const document = goodScenario()
  document.routes[0].quietHours = [{ timeZone: 'Not/A_Zone', start: '22:00', end: '07:00' }]
  const report = run(document)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.notifications, [])
})

test('canonical UTC timestamps are required', () => {
  const document = goodScenario()
  document.alerts[0].expiresAt = '2026-09-20T11:00:00Z'
  assert.equal(run(document).status, 'incomplete')
})

test('an omitted optional quietHours list leaves a correct route available', () => {
  const document = goodScenario()
  delete document.routes[0].quietHours
  assert.equal(run(document).status, 'pass')
})

test('byte limit stays silent at N and refuses a document at N+1', () => {
  const bytes = encode(goodScenario())
  assert.equal(simulate({ scenarioBytes: bytes, at: AT, clock: () => 0, limits: { maxBytes: bytes.length } }).status, 'pass')
  const refused = simulate({ scenarioBytes: bytes, at: AT, clock: () => 0, limits: { maxBytes: bytes.length - 1 } })
  assert.equal(refused.status, 'incomplete')
  assert.ok(refused.findings.some((finding) => finding.ruleId === 'byte-limit'))
})

test('alert, route and level limits stay silent at N and refuse N+1', () => {
  const document = goodScenario()
  assert.equal(run(document, { limits: { maxAlerts: 1, maxRoutes: 1, maxLevels: 1 } }).status, 'pass')
  const secondAlert = structuredClone(document)
  secondAlert.alerts.push({ ...secondAlert.alerts[0], fingerprint: 'alert-b' })
  assert.equal(run(secondAlert, { limits: { maxAlerts: 1 } }).status, 'incomplete')
  const secondRoute = structuredClone(document)
  secondRoute.routes.push(structuredClone(secondRoute.routes[0]))
  assert.equal(run(secondRoute, { limits: { maxRoutes: 1 } }).status, 'incomplete')
  const secondLevel = structuredClone(document)
  secondLevel.routes[0].escalations.push({ afterMs: 1, recipients: ['SYNTHETIC_TEAM_B'] })
  assert.equal(run(secondLevel, { limits: { maxLevels: 1 } }).status, 'incomplete')
})

test('depth limit stays silent at N and refuses N+1', () => {
  const document = goodScenario()
  assert.equal(run(document, { limits: { maxDepth: 6 } }).status, 'pass')
  const refused = run(document, { limits: { maxDepth: 5 } })
  assert.equal(refused.status, 'incomplete')
  assert.ok(refused.findings.some((finding) => finding.ruleId === 'depth-limit'))
})
