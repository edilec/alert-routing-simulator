import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { simulate } from '../src/index.mjs'

function assertOfflineSource(source) {
  assert.equal(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:node:)?(?:http|https|net|tls|dgram|dns)(?:\/[^'"]*)?['"]/u.test(source), false)
  assert.equal(/\b(?:fetch|WebSocket|EventSource)\s*\(/u.test(source), false)
  assert.equal(/\b(?:connect|createConnection|createServer|listen)\s*\(/u.test(source), false)
}

test('production source has no path that opens a network client or listener, and the gate can fail', async () => {
  for (const path of ['src/index.mjs', 'src/model.mjs', 'src/json.mjs', 'src/time.mjs', 'src/write-guard.mjs', 'bin/alert-routing-simulator.mjs']) {
    assertOfflineSource(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
  }
  assert.throws(() => assertOfflineSource("import net from 'node:net'"))
  assert.throws(() => assertOfflineSource("await import('node:net')"))
  assert.throws(() => assertOfflineSource('fetch("https://example.invalid")'))
})

test('active denied-network guard is exercised by a safe data URL while simulation stays offline', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => { calls += 1; throw new Error('network denied') }
  try {
    assert.throws(() => fetch('data:text/plain,probe'), /network denied/)
    assert.equal(calls, 1)
    const document = {
      schemaVersion: 1,
      alerts: [{ fingerprint: 'synthetic-a', occurredAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-20T11:00:00.000Z', labels: { service: 'api' } }],
      routes: [{ match: {}, groupBy: ['service'], groupWindowMs: 0, quietHours: [], escalations: [{ afterMs: 0, recipients: ['SYNTHETIC_TEAM'] }] }],
    }
    const report = simulate({ scenarioBytes: new TextEncoder().encode(JSON.stringify(document)), at: '2026-09-20T10:00:00.000Z', clock: () => 0 })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
    assert.equal(report.notifications.length, 1)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})
