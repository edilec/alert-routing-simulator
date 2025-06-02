import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, simulate } from '../src/index.mjs'

const AT = '2026-09-20T10:00:30.000Z'
const PASS_BYTES = readFileSync(new URL('../examples/scenario-pass.json', import.meta.url))
const FAIL_BYTES = readFileSync(new URL('../examples/scenario-fail.json', import.meta.url))
const BIN = new URL('../bin/alert-routing-simulator.mjs', import.meta.url)
const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const fresh = () => JSON.parse(PASS_BYTES)
const run = (scenarioBytes = PASS_BYTES, extra = {}) => simulate({ scenarioBytes, at: AT, clock: () => 0, ...extra })

function expectSeverity(report, ruleId, status = 'incomplete') {
  assert.equal(report.status, status, `${ruleId} status`)
  const finding = report.findings.find((entry) => entry.ruleId === ruleId)
  assert.ok(finding, `${ruleId} must be emitted by the real entry point`)
  assert.equal(finding.severity, 'error', `${ruleId} emitted severity`)
  assert.equal(report.summary.errors, report.findings.length, `${ruleId} error count`)
}

test('correct saved evidence emits no severity or false finding', () => {
  const report = run()
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.errors, 0)
})

const libraryCases = [
  ['alert-limit', () => run(PASS_BYTES, { limits: { maxAlerts: 1 } })],
  ['byte-limit', () => run(PASS_BYTES, { limits: { maxBytes: PASS_BYTES.byteLength - 1 } })],
  ['depth-limit', () => run(PASS_BYTES, { limits: { maxDepth: 5 } })],
  ['invalid-utf8', () => run(Uint8Array.from([0xc3, 0x28]))],
  ['level-limit', () => run(PASS_BYTES, { limits: { maxLevels: 1 } })],
  ['malformed-json', () => run(new TextEncoder().encode('{'))],
  ['no-alerts', () => { const d = fresh(); d.alerts = []; return run(encode(d)) }],
  ['numeric-precision', () => run(new TextEncoder().encode(
    PASS_BYTES.toString().replace('"groupWindowMs": 60000', '"groupWindowMs": 60000.000000000000001')))],
  ['route-limit', () => {
    const d = fresh()
    d.routes.push(structuredClone(d.routes[0]))
    return run(encode(d), { limits: { maxRoutes: 1 } })
  }],
  ['scenario-duplicate-key', () => run(new TextEncoder().encode(
    PASS_BYTES.toString().replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')))],
  ['scenario-invalid', () => { const d = fresh(); d.schemaVersion = 2; return run(encode(d)) }],
  ['scenario-unreadable', () => run(undefined, { scenarioBytes: undefined })],
  ['simulation-timeout', () => {
    let tick = 0
    return run(PASS_BYTES, { limits: { maxMillis: 1 }, clock: () => tick++ === 0 ? 0 : 2 })
  }],
  ['clock-invalid', () => {
    let tick = 0
    return run(PASS_BYTES, { clock: () => tick++ === 0 ? 0 : NaN })
  }],
  ['timezone-unsupported', () => {
    const d = fresh()
    d.routes[0].quietHours[0].timeZone = 'Not/A_Zone'
    return run(encode(d))
  }],
  ['time-overflow', () => {
    const d = fresh()
    d.routes[0].escalations[1].afterMs = Number.MAX_SAFE_INTEGER
    return run(encode(d))
  }],
  ['unrouted-alert', () => run(FAIL_BYTES)],
]

test('each declared rule has a real-entry emitted-severity case', () => {
  const exercised = [
    ...libraryCases.map(([ruleId]) => ruleId),
    'timezone-conversion-failed',
    'input-unreadable', 'input-outside-root', 'output-refused', 'output-unwritable',
  ]
  assert.deepEqual(exercised.sort(), Object.keys(RULE_SEVERITY).sort())
})

for (const [ruleId, exercise] of libraryCases) {
  test(`${ruleId} emits its documented error severity through simulate`, () => {
    expectSeverity(exercise(), ruleId, ruleId === 'unrouted-alert' ? 'fail' : 'incomplete')
  })
}

test('timezone-conversion-failed emits error severity through simulate', () => {
  const d = fresh()
  d.routes[0].quietHours[0] = { timeZone: 'UTC', start: '09:00', end: '11:00' }
  const original = Intl.DateTimeFormat.prototype.formatToParts
  Intl.DateTimeFormat.prototype.formatToParts = () => { throw new RangeError('synthetic conversion failure') }
  try {
    expectSeverity(run(encode(d)), 'timezone-conversion-failed')
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original
  }
})

function cli(root, input, extra = []) {
  const result = spawnSync(process.execPath, [BIN.pathname, '--root', root, '--scenario', input, '--at', AT, '--json', ...extra], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

test('filesystem input and output failures emit documented error severity through the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alert-severity-'))
  const outside = await mkdtemp(join(tmpdir(), 'alert-severity-outside-'))
  try {
    const input = join(root, 'scenario.json')
    await writeFile(input, PASS_BYTES)
    expectSeverity(cli(root, join(root, 'missing.json')), 'input-unreadable')

    const link = join(root, 'outside.json')
    await symlink(join(outside, 'scenario.json'), link)
    await writeFile(join(outside, 'scenario.json'), PASS_BYTES)
    expectSeverity(cli(root, link), 'input-outside-root')

    expectSeverity(cli(root, input, ['--report', input]), 'output-refused')

    const readonly = join(root, 'readonly.json')
    await writeFile(readonly, 'synthetic sentinel')
    await chmod(readonly, 0o444)
    expectSeverity(cli(root, input, ['--report', readonly]), 'output-unwritable')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
