const FORBIDDEN_LABEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const LOCAL_MINUTE = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function label(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !FORBIDDEN_LABEL.test(value)
}

function labelMap(value) {
  return isRecord(value) && Object.entries(value).every(([key, entry]) => label(key) && label(entry))
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

export function parseInstant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value)) return null
  const instant = Date.parse(value)
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) return null
  return instant
}

function problem(ruleId, pointer, message) {
  return { ruleId, pointer, message }
}

export function validateScenario(document, limits) {
  const problems = []
  if (!isRecord(document) || !exactKeys(document, ['schemaVersion', 'alerts', 'routes']) || document.schemaVersion !== 1) {
    return { problems: [problem('scenario-invalid', '', 'The scenario envelope is unsupported or malformed.')] }
  }
  if (!Array.isArray(document.alerts) || !Array.isArray(document.routes)) {
    return { problems: [problem('scenario-invalid', '', 'The scenario must declare alerts and routes arrays.')] }
  }
  if (document.alerts.length > limits.maxAlerts) problems.push(problem('alert-limit', '/alerts', 'The scenario exceeds maxAlerts.'))
  if (document.routes.length > limits.maxRoutes) problems.push(problem('route-limit', '/routes', 'The scenario exceeds maxRoutes.'))
  if (problems.length > 0) return { problems }

  const alerts = []
  for (let index = 0; index < document.alerts.length; index += 1) {
    const entry = document.alerts[index]
    const pointer = `/alerts/${index}`
    if (!isRecord(entry) || !exactKeys(entry, ['fingerprint', 'occurredAt', 'expiresAt', 'labels'])
      || !label(entry.fingerprint) || !labelMap(entry.labels)) {
      problems.push(problem('scenario-invalid', pointer, 'This alert has an unsupported shape or identity.'))
      continue
    }
    const occurredAt = parseInstant(entry.occurredAt)
    const expiresAt = parseInstant(entry.expiresAt)
    if (occurredAt === null || expiresAt === null || expiresAt <= occurredAt) {
      problems.push(problem('scenario-invalid', pointer, 'This alert has invalid UTC occurrence or expiry evidence.'))
      continue
    }
    alerts.push({ index, fingerprint: entry.fingerprint, occurredAt, expiresAt, labels: entry.labels })
  }

  const routes = []
  for (let index = 0; index < document.routes.length; index += 1) {
    const entry = document.routes[index]
    const pointer = `/routes/${index}`
    if (!isRecord(entry) || !exactKeys(entry, ['match', 'groupBy', 'groupWindowMs', 'quietHours', 'escalations'])
      || !labelMap(entry.match) || !Array.isArray(entry.groupBy)
      || !entry.groupBy.every(label) || new Set(entry.groupBy).size !== entry.groupBy.length
      || !nonnegativeInteger(entry.groupWindowMs)
      || (entry.quietHours !== undefined && !Array.isArray(entry.quietHours))
      || !Array.isArray(entry.escalations) || entry.escalations.length === 0) {
      problems.push(problem('scenario-invalid', pointer, 'This route has an unsupported shape or grouping rule.'))
      continue
    }
    if (entry.escalations.length > limits.maxLevels) {
      problems.push(problem('level-limit', `${pointer}/escalations`, 'This route exceeds maxLevels.'))
      continue
    }
    let valid = true
    const quietHours = []
    const declaredQuietHours = entry.quietHours ?? []
    for (let quietIndex = 0; quietIndex < declaredQuietHours.length; quietIndex += 1) {
      const quiet = declaredQuietHours[quietIndex]
      if (!isRecord(quiet) || !exactKeys(quiet, ['timeZone', 'start', 'end'])
        || !label(quiet.timeZone) || !LOCAL_MINUTE.test(quiet.start ?? '')
        || !LOCAL_MINUTE.test(quiet.end ?? '') || quiet.start === quiet.end) {
        problems.push(problem('scenario-invalid', `${pointer}/quietHours/${quietIndex}`, 'This quiet-hour window is invalid.'))
        valid = false
        continue
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: quiet.timeZone }).format(new Date(0))
      } catch {
        problems.push(problem('timezone-unsupported', `${pointer}/quietHours/${quietIndex}/timeZone`, 'This IANA timezone cannot be evaluated.'))
        valid = false
        continue
      }
      quietHours.push(quiet)
    }
    const escalations = []
    let previousAfter = -1
    for (let levelIndex = 0; levelIndex < entry.escalations.length; levelIndex += 1) {
      const level = entry.escalations[levelIndex]
      if (!isRecord(level) || !exactKeys(level, ['afterMs', 'recipients'])
        || !nonnegativeInteger(level.afterMs) || level.afterMs <= previousAfter
        || !Array.isArray(level.recipients) || level.recipients.length === 0
        || !level.recipients.every(label) || new Set(level.recipients).size !== level.recipients.length) {
        problems.push(problem('scenario-invalid', `${pointer}/escalations/${levelIndex}`, 'This escalation level is invalid.'))
        valid = false
        continue
      }
      previousAfter = level.afterMs
      escalations.push({ index: levelIndex, afterMs: level.afterMs, recipients: level.recipients })
    }
    if (valid) routes.push({ index, match: entry.match, groupBy: entry.groupBy, groupWindowMs: entry.groupWindowMs, quietHours, escalations })
  }
  if (problems.length > 0) return { problems }

  for (const alert of alerts) {
    const route = routes.find((entry) => Object.entries(entry.match).every(([key, value]) => alert.labels[key] === value))
    if (route !== undefined && route.groupBy.some((key) => !Object.hasOwn(alert.labels, key))) {
      problems.push(problem('scenario-invalid', `/alerts/${alert.index}/labels`, 'A matching route requires a grouping label this alert does not provide.'))
    }
  }
  return { alerts, routes, problems }
}
