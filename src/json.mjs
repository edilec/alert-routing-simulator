export class EvidenceError extends Error {
  constructor(code) {
    super(code)
    this.name = 'EvidenceError'
    this.code = code
  }
}

function canonicalDecimal(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/u.exec(token)
  if (match === null) throw new EvidenceError('numeric-precision')
  const fraction = match[3] ?? ''
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, '')
  if (digits === '') return '0'
  const exponentDigits = (match[5] ?? '0').replace(/^0+/u, '') || '0'
  const largest = String(token.length + 324)
  if (exponentDigits.length > largest.length || (exponentDigits.length === largest.length && exponentDigits > largest)) {
    throw new EvidenceError('numeric-precision')
  }
  let exponent = BigInt(exponentDigits) * (match[4] === '-' ? -1n : 1n) - BigInt(fraction.length)
  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0
  digits = digits.slice(0, digits.length - trailing)
  exponent += BigInt(trailing)
  return `${match[1]}${digits}e${exponent}`
}

export function parseUniqueJson(bytes, { maxBytes, maxDepth }) {
  if (!(bytes instanceof Uint8Array)) throw new EvidenceError('scenario-unreadable')
  if (bytes.byteLength > maxBytes) throw new EvidenceError('byte-limit')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new EvidenceError('invalid-utf8')
  }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    throw new EvidenceError('malformed-json')
  }

  let index = 0
  const spaces = () => { while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1 }
  const quoted = () => {
    const start = index
    index += 1
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue }
      if (text[index] === '"') { index += 1; return JSON.parse(text.slice(start, index)) }
      index += 1
    }
    throw new EvidenceError('malformed-json')
  }
  const value = (depth) => {
    spaces()
    if (depth > maxDepth) throw new EvidenceError('depth-limit')
    if (text[index] === '"') { quoted(); return }
    if (text[index] === '{') {
      index += 1
      const keys = new Set()
      spaces()
      while (text[index] !== '}') {
        const key = quoted()
        if (keys.has(key)) throw new EvidenceError('scenario-duplicate-key')
        keys.add(key)
        spaces()
        index += 1 // colon: JSON.parse has already validated syntax
        value(depth + 1)
        spaces()
        if (text[index] !== ',') break
        index += 1
        spaces()
      }
      index += 1
      return
    }
    if (text[index] === '[') {
      index += 1
      spaces()
      while (text[index] !== ']') {
        value(depth + 1)
        spaces()
        if (text[index] !== ',') break
        index += 1
      }
      index += 1
      return
    }
    if (text[index] === 't') { index += 4; return }
    if (text[index] === 'f') { index += 5; return }
    if (text[index] === 'n') { index += 4; return }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index))?.[0]
    if (token === undefined) throw new EvidenceError('malformed-json')
    const numeric = Number(token)
    if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER) throw new EvidenceError('numeric-precision')
    if (canonicalDecimal(token) !== canonicalDecimal(numeric.toString())) throw new EvidenceError('numeric-precision')
    index += token.length
  }
  value(0)
  return document
}
