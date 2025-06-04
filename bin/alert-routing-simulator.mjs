#!/usr/bin/env node

import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

import { DEFAULT_LIMITS, MAX_SOURCE_UNITS, incompleteReport, simulate } from '../src/index.mjs'
import { parseInstant } from '../src/model.mjs'
import { assertWritableDestination } from '../src/write-guard.mjs'

const USAGE = `Usage: alert-routing-simulator --root DIR --scenario FILE --at YYYY-MM-DDTHH:mm:ss.sssZ [--report FILE] [--json]

Options:
  --root DIR          Required confinement root for input and optional report.
  --scenario FILE     Saved JSON scenario, relative to root or absolute.
  --at UTC            Injected virtual UTC cutoff (canonical milliseconds).
  --report FILE       Optional JSON output inside root; stdout remains identical.
  --json               Suppress the human stderr summary (not diagnostics).
  --max-bytes N        Default ${DEFAULT_LIMITS.maxBytes}.
  --max-alerts N       Default ${DEFAULT_LIMITS.maxAlerts}.
  --max-routes N       Default ${DEFAULT_LIMITS.maxRoutes}.
  --max-levels N       Default ${DEFAULT_LIMITS.maxLevels} per route.
  --max-depth N        Default ${DEFAULT_LIMITS.maxDepth}.
  --max-millis N       Default ${DEFAULT_LIMITS.maxMillis} elapsed milliseconds.
  --help               Show this text. No input is read or report written.

This tool reads saved evidence only. It never contacts recipients or sends notifications.
`

const LIMIT_FLAGS = Object.freeze({
  '--max-bytes': 'maxBytes', '--max-alerts': 'maxAlerts', '--max-routes': 'maxRoutes',
  '--max-levels': 'maxLevels', '--max-depth': 'maxDepth', '--max-millis': 'maxMillis',
})

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      if (flags.has(flag)) throw new TypeError('Repeated option.')
      flags.set(flag, true)
      continue
    }
    if (!['--root', '--scenario', '--at', '--report', ...Object.keys(LIMIT_FLAGS)].includes(flag)
      || flags.has(flag) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new TypeError('Invalid option.')
    flags.set(flag, argv[++index])
  }
  for (const required of ['--root', '--scenario', '--at']) if (!flags.has(required)) throw new TypeError('Missing required option.')
  if (parseInstant(flags.get('--at')) === null) throw new TypeError('Invalid cutoff.')
  const limits = {}
  for (const [flag, name] of Object.entries(LIMIT_FLAGS)) {
    if (!flags.has(flag)) continue
    const text = flags.get(flag)
    if (!/^[1-9]\d*$/u.test(text)) throw new TypeError('Invalid limit.')
    const value = Number(text)
    if (!Number.isSafeInteger(value)) throw new TypeError('Invalid limit.')
    limits[name] = value
  }
  return {
    root: flags.get('--root'), scenario: flags.get('--scenario'), at: flags.get('--at'),
    output: flags.get('--report'), json: flags.has('--json'), limits,
  }
}

function withinRoot(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function safeSource(root, named) {
  // The named path is the source location. A realpath is used for confinement,
  // but switching to it here would silently change the user's provenance.
  const rel = withinRoot(root, named) ? relative(root, named) : basename(named)
  if (rel.length === 0) return 'scenario-root'
  let display = ''
  for (let index = 0; index < rel.length; index += 1) {
    const unit = rel[index]
    display += /[A-Za-z0-9._/-]/u.test(unit) ? unit : `%${rel.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return display
}

function jsonBytes(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

async function main() {
  let config
  let realRoot
  let namedInput
  let namedOutput
  let source
  try {
    config = parseArgs(process.argv.slice(2))
    if (config.help) {
      process.stdout.write(USAGE)
      return 0
    }
    realRoot = await realpath(resolve(config.root))
    if (!(await stat(realRoot)).isDirectory()) throw new TypeError('Root is not a directory.')
    namedInput = resolve(realRoot, config.scenario)
    namedOutput = config.output === undefined ? null : resolve(realRoot, config.output)
    source = safeSource(realRoot, namedInput)
    if (source.length > MAX_SOURCE_UNITS) throw new TypeError('Source label exceeds its bound.')
  } catch {
    process.stderr.write('Invalid configuration. Use --help for usage.\n')
    return 2
  }

  let actualInput = null
  let result
  try {
    actualInput = await realpath(namedInput)
    if (!withinRoot(realRoot, actualInput)) {
      result = incompleteReport(source, 'input-outside-root')
    } else {
      source = safeSource(realRoot, namedInput)
      const metadata = await stat(actualInput)
      if (!metadata.isFile()) {
        result = incompleteReport(source, 'input-unreadable')
      } else if (metadata.size > (config.limits.maxBytes ?? DEFAULT_LIMITS.maxBytes)) {
        result = incompleteReport(source, 'byte-limit')
      } else {
        const scenarioBytes = await readFile(actualInput)
        result = simulate({ scenarioBytes, at: config.at, limits: config.limits, source })
      }
    }
  } catch {
    result = incompleteReport(source, 'input-unreadable')
  }

  if (namedOutput !== null) {
    try {
      await assertWritableDestination(namedOutput, {
        inputs: actualInput === null ? [realRoot, namedInput] : [realRoot, namedInput, actualInput],
        root: realRoot, label: '--report',
      })
    } catch {
      result = incompleteReport(source, 'output-refused')
    }
    if (result.findings[0]?.ruleId !== 'output-refused') {
      try { await writeFile(namedOutput, jsonBytes(result)) }
      catch { result = incompleteReport(source, 'output-unwritable') }
    }
  }

  process.stdout.write(jsonBytes(result))
  if (!config.json) process.stderr.write(`alert-routing-simulator: status ${result.status}; checked ${result.summary.checked} alert(s), ${result.summary.notifications} intended notification(s).\n`)
  return result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2
}

process.exitCode = await main()
