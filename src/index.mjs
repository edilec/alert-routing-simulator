import { performance } from 'node:perf_hooks'
import { isAbsolute, sep } from 'node:path'

import { EvidenceError, parseUniqueJson } from './json.mjs'
import { parseInstant, validateScenario } from './model.mjs'
import { isQuietAt, TimezoneConversionError } from './time.mjs'

export const TOOL_ID = 'alert-routing-simulator'
export const MAX_SOURCE_UNITS = 4096
export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 1_048_576, maxAlerts: 1000, maxRoutes: 100, maxLevels: 16, maxDepth: 16, maxMillis: 5000 })
export const RULE_SEVERITY = Object.freeze({
  'alert-limit': 'error',
  'byte-limit': 'error',
  'depth-limit': 'error',
  'invalid-utf8': 'error',
  'input-outside-root': 'error',
  'input-unreadable': 'error',
  'level-limit': 'error',
  'malformed-json': 'error',
  'no-alerts': 'error',
  'numeric-precision': 'error',
  'route-limit': 'error',
  'output-refused': 'error',
  'output-unwritable': 'error',
  'scenario-duplicate-key': 'error',
  'scenario-invalid': 'error',
  'scenario-unreadable': 'error',
  'simulation-timeout': 'error',
  'clock-invalid': 'error',
  'timezone-conversion-failed': 'error',
  'timezone-unsupported': 'error',
  'time-overflow': 'error',
  'unrouted-alert': 'error',
})

const INCOMPLETE = new Set(Object.keys(RULE_SEVERITY).filter((rule) => rule !== 'unrouted-alert'))
const OPTIONS = Object.freeze(['scenarioBytes', 'at', 'limits', 'clock', 'source'])
export const compareCodeUnits = (left, right) => left === right ? 0 : left < right ? -1 : 1

function configuration(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Options must be an object.')
  if (Object.keys(input).some((key) => !OPTIONS.includes(key))) throw new TypeError('Unknown option.')
  const at = parseInstant(input.at)
  if (at === null) throw new TypeError('An explicit canonical UTC --at is required.')
  const configured = input.limits ?? {}
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) throw new TypeError('Limits must be an object.')
  if (Object.keys(configured).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw new TypeError('Unknown limit.')
  const limits = { ...DEFAULT_LIMITS, ...configured }
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('Limits must be positive safe integers.')
  const clock = input.clock ?? performance.now.bind(performance)
  if (typeof clock !== 'function') throw new TypeError('Clock must be a function.')
  const source = input.source ?? 'scenario.json'
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_SOURCE_UNITS || isAbsolute(source)
    || source.split(sep).includes('..') || /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(source)) {
    throw new TypeError('Source must be a safe nonempty relative path of at most 4096 UTF-16 units.')
  }
  return { at, limits, clock, source }
}

function report(source, checked, findings, decisions = [], notifications = []) {
  for (const entry of findings) {
    entry.severity = RULE_SEVERITY[entry.ruleId]
    if (entry.severity === undefined) throw new TypeError('Undeclared rule severity.')
    entry.location = { file: source, pointer: entry.pointer }
    delete entry.pointer
  }
  findings.sort((left, right) => compareCodeUnits(left.location.file, right.location.file)
    || compareCodeUnits(left.location.pointer, right.location.pointer) || compareCodeUnits(left.ruleId, right.ruleId))
  const incomplete = findings.some((entry) => INCOMPLETE.has(entry.ruleId))
  const status = incomplete ? 'incomplete' : findings.some((entry) => entry.severity === 'error') ? 'fail' : 'pass'
  return {
    schemaVersion: '1', tool: TOOL_ID, status,
    summary: { checked, errors: findings.filter((entry) => entry.severity === 'error').length, warnings: 0, groups: new Set(decisions.map((decision) => decision.groupIndex)).size, notifications: notifications.length },
    findings, decisions, notifications,
  }
}

function finding(ruleId, pointer, message) {
  return { ruleId, pointer, message }
}

export function incompleteReport(source, ruleId) {
  const messages = Object.freeze({
    'byte-limit': 'The named scenario exceeds the configured input byte limit and was not read.',
    'input-outside-root': 'The named scenario resolves outside the declared root and was not read.',
    'input-unreadable': 'The named scenario could not be read as a regular file.',
    'output-refused': 'The report destination was refused to protect an input or the declared root.',
    'output-unwritable': 'The report destination could not be written.',
  })
  if (!Object.hasOwn(messages, ruleId)) throw new TypeError('Unknown incomplete-report rule.')
  return report(source, 0, [finding(ruleId, '', messages[ruleId])])
}

export function simulate(input = {}) {
  const { at, limits, clock, source } = configuration(input)
  const stopped = (ruleId) => report(source, 0, [finding(ruleId, '', 'The simulation could not complete within its declared time evidence.')])
  let started
  try { started = clock() } catch { return stopped('clock-invalid') }
  if (typeof started !== 'number' || !Number.isFinite(started)) return stopped('clock-invalid')
  let previousTick = started
  const elapsedProblem = () => {
    let tick
    try { tick = clock() } catch { return 'clock-invalid' }
    if (typeof tick !== 'number' || !Number.isFinite(tick) || tick < previousTick) return 'clock-invalid'
    previousTick = tick
    return tick - started > limits.maxMillis ? 'simulation-timeout' : null
  }
  let document
  try {
    document = parseUniqueJson(input.scenarioBytes, limits)
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error
    return report(source, 0, [finding(error.code, '', 'The scenario could not be fully read or evaluated.')])
  }
  const postParseProblem = elapsedProblem()
  if (postParseProblem !== null) return stopped(postParseProblem)
  const model = validateScenario(document, limits)
  const postModelProblem = elapsedProblem()
  if (postModelProblem !== null) return stopped(postModelProblem)
  if (model.problems.length > 0) return report(source, 0, model.problems)
  if (model.alerts.length === 0) return report(source, 0, [finding('no-alerts', '/alerts', 'No alert was available to evaluate.')])

  const decisions = []
  const notifications = []
  const findings = []
  let checked = 0
  const groups = []
  const byKey = new Map()
  const alerts = [...model.alerts].sort((left, right) => left.occurredAt - right.occurredAt || left.index - right.index)
  for (const alert of alerts) {
    const timeProblem = elapsedProblem()
    if (timeProblem !== null) return stopped(timeProblem)
    if (alert.occurredAt > at) continue
    checked += 1
    const route = model.routes.find((entry) => Object.entries(entry.match).every(([key, value]) => alert.labels[key] === value))
    if (route === undefined) {
      findings.push(finding('unrouted-alert', `/alerts/${alert.index}`, 'This alert matches no declared route.'))
      continue
    }
    const key = JSON.stringify([route.index, ...route.groupBy.map((name) => alert.labels[name])])
    let routeGroups = byKey.get(key)
    if (routeGroups === undefined) {
      routeGroups = []
      byKey.set(key, routeGroups)
    }
    let group = routeGroups.at(-1)
    if (group === undefined || alert.occurredAt - group.start > route.groupWindowMs) {
      group = { index: groups.length, route, start: alert.occurredAt, alerts: [] }
      groups.push(group)
      routeGroups.push(group)
    }
    group.alerts.push(alert)
  }
  for (const group of groups) {
    const { route } = group
    for (const level of route.escalations) {
      const timeProblem = elapsedProblem()
      if (timeProblem !== null) return stopped(timeProblem)
      const due = group.start + level.afterMs
      if (!Number.isSafeInteger(due) || !Number.isFinite(new Date(due).getTime())) {
        return report(source, checked, [finding('time-overflow', `/routes/${route.index}/escalations/${level.index}/afterMs`, 'An escalation due instant is outside the supported UTC range.')])
      }
      const dueAt = new Date(due).toISOString()
      const active = group.alerts.filter((alert) => alert.occurredAt <= due && due < alert.expiresAt)
      const activeAlerts = new Set(active.map((alert) => alert.fingerprint)).size
      let state = due > at ? 'pending' : activeAlerts === 0 ? 'expired' : 'ready'
      if (state === 'ready') {
        try {
          if (isQuietAt(route.quietHours, due)) state = 'suppressed-quiet'
        } catch (error) {
          if (!(error instanceof TimezoneConversionError)) throw error
          return report(source, 0, [finding('timezone-conversion-failed', `/routes/${route.index}/quietHours`, 'The route timezone could not be converted at this escalation instant.')])
        }
      }
      const decision = {
        groupIndex: group.index, routePointer: `/routes/${route.index}`, levelPointer: `/routes/${route.index}/escalations/${level.index}`,
        alertPointers: due > at ? [] : active.map((alert) => `/alerts/${alert.index}`),
        dueAt, activeAlerts: due > at ? null : activeAlerts, state,
      }
      decisions.push(decision)
      if (state === 'ready') notifications.push({ ...decision, recipientPointers: level.recipients.map((_, index) => `${decision.levelPointer}/recipients/${index}`) })
    }
  }
  if (checked === 0) findings.push(finding('no-alerts', '/alerts', 'No alert was available at the virtual cutoff.'))
  return report(source, checked, findings, decisions, notifications)
}
