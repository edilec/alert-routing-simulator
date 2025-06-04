import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const BIN = new URL('../bin/alert-routing-simulator.mjs', import.meta.url)
const AT = '2026-09-20T10:00:00.000Z'
const cli = (args) => spawnSync(process.execPath, [BIN.pathname, ...args], { encoding: 'utf8' })

function scenario() {
  return {
    schemaVersion: 1,
    alerts: [{ fingerprint: 'synthetic-a', occurredAt: AT, expiresAt: '2026-09-20T11:00:00.000Z', labels: { service: 'api' } }],
    routes: [{ match: {}, groupBy: ['service'], groupWindowMs: 60_000, quietHours: [], escalations: [{ afterMs: 0, recipients: ['SYNTHETIC_TEAM_A'] }] }],
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alert-routing-test-'))
  const input = join(root, 'scenario.json')
  await writeFile(input, JSON.stringify(scenario()))
  return { root, input, clean: () => rm(root, { recursive: true, force: true }) }
}

test('a correct saved scenario prints JSON and a human summary without contacting recipients', async () => {
  const f = await fixture()
  try {
    const run = cli(['--root', f.root, '--scenario', f.input, '--at', AT])
    assert.equal(run.status, 0)
    const report = JSON.parse(run.stdout)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
    assert.equal(report.notifications.length, 1)
    assert.match(run.stderr, /status pass/)
    assert.equal(run.stdout.includes('SYNTHETIC_TEAM_A'), false)
    assert.equal(run.stderr.includes('SYNTHETIC_TEAM_A'), false)
    const json = cli(['--root', f.root, '--scenario', f.input, '--at', AT, '--json'])
    assert.equal(json.status, 0)
    assert.equal(json.stderr, '')
    assert.equal(json.stdout, run.stdout)
  } finally { await f.clean() }
})

test('--help is offline, prints usage and exits zero', () => {
  const run = cli(['--help'])
  assert.equal(run.status, 0)
  assert.match(run.stdout, /--scenario/)
  assert.match(run.stdout, /--report/)
})

test('invalid options and roots exit two with empty stdout and a fixed diagnostic', async () => {
  const f = await fixture()
  try {
    for (const args of [
      ['--bad-option'],
      ['--json', '--bad-option'],
      ['--root', join(f.root, 'missing'), '--scenario', f.input, '--at', AT],
      ['--root', f.input, '--scenario', f.input, '--at', AT],
    ]) {
      const run = cli(args)
      assert.equal(run.status, 2)
      assert.equal(run.stdout, '')
      assert.match(run.stderr, /Invalid configuration/)
    }
  } finally { await f.clean() }
})

test('an oversized encoded source path is invalid configuration, not a long report label', async () => {
  const f = await fixture()
  try {
    const run = cli(['--root', f.root, '--scenario', join(f.root, 'x'.repeat(4097)), '--at', AT, '--json'])
    assert.equal(run.status, 2)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, 'Invalid configuration. Use --help for usage.\n')
  } finally { await f.clean() }
})

test('an unreadable named scenario exits two with an incomplete JSON report', async () => {
  const f = await fixture()
  try {
    const run = cli(['--root', f.root, '--scenario', join(f.root, 'missing.json'), '--at', AT, '--json'])
    assert.equal(run.status, 2)
    const report = JSON.parse(run.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.notifications, [])
    assert.ok(report.findings.some((finding) => finding.ruleId === 'input-unreadable'))
  } finally { await f.clean() }
})

test('distinct unreadable scenario names retain distinct safe relative provenance', async () => {
  const f = await fixture()
  try {
    const labels = ['name\u0085.json', 'name .json', 'name%0085.json']
    const reports = labels.map((name) => {
      const run = cli(['--root', f.root, '--scenario', join(f.root, name), '--at', AT, '--json'])
      assert.equal(run.status, 2)
      assert.equal(run.stderr, '')
      const report = JSON.parse(run.stdout)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.findings[0].ruleId, 'input-unreadable')
      assert.equal(run.stdout.includes('\u0085'), false)
      assert.equal(run.stdout.includes(f.root), false)
      return report.findings[0].location.file
    })
    assert.deepEqual(reports, ['name%0085.json', 'name%0020.json', 'name%00250085.json'])
    assert.equal(new Set(reports).size, reports.length)
    const human = cli(['--root', f.root, '--scenario', join(f.root, labels[0]), '--at', AT])
    assert.equal(human.status, 2)
    assert.equal(human.stderr.includes(f.root), false)
    assert.equal(human.stderr.includes('\u0085'), false)
    assert.equal(JSON.parse(human.stdout).findings[0].location.file, reports[0])
  } finally { await f.clean() }
})

test('a fully evaluated route gap exits one with an error finding', async () => {
  const f = await fixture()
  try {
    const document = scenario()
    document.routes[0].match = { severity: 'critical' }
    await writeFile(f.input, JSON.stringify(document))
    const run = cli(['--root', f.root, '--scenario', f.input, '--at', AT, '--json'])
    assert.equal(run.status, 1)
    assert.equal(JSON.parse(run.stdout).findings[0].ruleId, 'unrouted-alert')
  } finally { await f.clean() }
})

test('root slash and safe report target preserve byte-identical stdout and file', async () => {
  const f = await fixture()
  try {
    const output = join(f.root, 'report.json')
    const run = cli(['--root', '/', '--scenario', f.input, '--at', AT, '--report', output, '--json'])
    assert.equal(run.status, 0)
    assert.equal(run.stderr, '')
    assert.equal(await readFile(output, 'utf8'), run.stdout)
    assert.equal(JSON.parse(run.stdout).status, 'pass')
    const again = cli(['--root', '/', '--scenario', f.input, '--at', AT, '--report', output, '--json'])
    assert.equal(again.status, 0)
    assert.equal(again.stdout, run.stdout)
    assert.equal(await readFile(output, 'utf8'), run.stdout)
  } finally { await f.clean() }
})

test('CLI byte limit accepts exactly N and marks N+1 evidence incomplete', async () => {
  const f = await fixture()
  try {
    const bytes = (await readFile(f.input)).byteLength
    const args = ['--root', f.root, '--scenario', f.input, '--at', AT, '--json', '--max-bytes']
    const exact = cli([...args, String(bytes)])
    assert.equal(exact.status, 0)
    assert.equal(JSON.parse(exact.stdout).status, 'pass')
    const over = cli([...args, String(bytes - 1)])
    assert.equal(over.status, 2)
    const report = JSON.parse(over.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.notifications, [])
    assert.equal(report.findings[0].ruleId, 'byte-limit')
  } finally { await f.clean() }
})

test('a symlink escaping the declared read root cannot supply false provenance', async () => {
  const f = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'alert-routing-outside-'))
  try {
    const target = join(outside, 'outside.json')
    await writeFile(target, JSON.stringify(scenario()))
    await symlink(target, join(f.root, 'linked.json'))
    const run = cli(['--root', f.root, '--scenario', join(f.root, 'linked.json'), '--at', AT, '--json'])
    assert.equal(run.status, 2)
    const report = JSON.parse(run.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.notifications, [])
    assert.ok(report.findings.some((finding) => finding.ruleId === 'input-outside-root'))
  } finally { await f.clean(); await rm(outside, { recursive: true, force: true }) }
})

test('safe missing input and distinct report destination produce an incomplete file', async () => {
  const f = await fixture()
  try {
    const missing = join(f.root, 'missing.json')
    const output = join(f.root, 'report.json')
    const run = cli(['--root', f.root, '--scenario', missing, '--at', AT, '--report', output, '--json'])
    assert.equal(run.status, 2)
    assert.equal(JSON.parse(run.stdout).status, 'incomplete')
    assert.equal(await readFile(output, 'utf8'), run.stdout)
  } finally { await f.clean() }
})

test('destination symlink, parent escape, hard link and direct input alias are refused without modifying inputs', async () => {
  const f = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'alert-routing-outside-'))
  try {
    const original = await readFile(f.input, 'utf8')
    const outsideFile = join(outside, 'outside.json')
    await writeFile(outsideFile, 'outside sentinel')
    const destinationLink = join(f.root, 'output-link.json')
    await symlink(outsideFile, destinationLink)
    const parentLink = join(f.root, 'escape')
    await symlink(outside, parentLink)
    const hard = join(f.root, 'hard.json')
    await link(f.input, hard)
    for (const output of [destinationLink, join(parentLink, 'new.json'), hard, f.input]) {
      const run = cli(['--root', f.root, '--scenario', f.input, '--at', AT, '--report', output, '--json'])
      assert.equal(run.status, 2)
      assert.equal(JSON.parse(run.stdout).status, 'incomplete')
      assert.deepEqual(JSON.parse(run.stdout).notifications, [])
      assert.equal(await readFile(f.input, 'utf8'), original)
      assert.equal(await readFile(outsideFile, 'utf8'), 'outside sentinel')
    }
  } finally { await f.clean(); await rm(outside, { recursive: true, force: true }) }
})

test('a dangling input symlink cannot be made readable by its report destination', async () => {
  const f = await fixture()
  try {
    const output = join(f.root, 'report.json')
    const alias = join(f.root, 'alias.json')
    const middle = join(f.root, 'middle.json')
    await symlink(output, alias)
    await symlink(output, middle)
    const twoHop = join(f.root, 'two-hop.json')
    await symlink(middle, twoHop)
    for (const input of [alias, twoHop]) {
      const run = cli(['--root', f.root, '--scenario', input, '--at', AT, '--report', output, '--json'])
      assert.equal(run.status, 2)
      assert.equal(JSON.parse(run.stdout).status, 'incomplete')
      assert.deepEqual(JSON.parse(run.stdout).notifications, [])
      await assert.rejects(readFile(output), { code: 'ENOENT' })
    }
  } finally { await f.clean() }
})
