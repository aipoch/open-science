import {
  isSensitiveDiagnosticKey,
  isSensitiveUrlQueryKey,
  redactSensitiveText
} from '../../shared/diagnostic-redaction'
import type { SensitiveContentEvidence } from '../../shared/session-package'
import { createHash } from 'node:crypto'
import { PackageJsonSyntax } from './json-syntax'

// Export decisions are distinct from log redaction: empty values and the exact redaction
// marker are not credentials, and a URL parser failure alone is not evidence of a secret.
const decodeEscapes = (value: string): string =>
  value.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))

export const isPrivatePackageValue = (value: string): boolean => {
  const text = decodeEscapes(value)
    .trim()
    .replace(/^(?:Bearer|Basic|Digest|Negotiate)\s+/i, '')
  return text !== '' && text !== '[redacted]'
}

export type PackageSensitiveContentSource = {
  storageKey: string
  root: string
  relativePath: string
  checksum?: string
}

export type PackageTextMatch = {
  offset: number
  length: number
  valueOffset?: number
  valueLength?: number
  rule: 'field' | 'assignment' | 'url' | 'token'
  label?: string
}

type Boundary = Exclude<
  SensitiveContentEvidence['leftBoundary'] | SensitiveContentEvidence['rightBoundary'],
  'start' | 'end'
>
const boundary = (value: string): Boundary => {
  if (/\p{L}/u.test(value)) return 'letter'
  if (/\p{N}/u.test(value)) return 'number'
  if (/\p{M}/u.test(value)) return 'mark'
  if (/\s/u.test(value)) return 'whitespace'
  if (/\p{P}|\p{S}/u.test(value)) return 'punctuation'
  return 'other'
}

type DeclarationState = 'accepted' | 'pending' | 'rejected'
const MAX_DECLARATION_TEXT = 4096
const numericTokenUsageKeys = ['knownTokenUnits', 'knownDispatchedTokenUnits'] as const

// Recognize references to recipient-supplied environment credentials, never credential values.
// This is a bounded JSON structure rule, independent of filenames or package document formats.
const credentialDeclarations = (text: string, complete: boolean): DeclarationState => {
  if (!text.startsWith('[')) return 'rejected'
  let depth = 0
  let quoted = false
  let escaped = false
  let end = 0
  for (; end < Math.min(text.length, MAX_DECLARATION_TEXT); end++) {
    const char = text[end]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') {
      depth--
      if (depth === 0) break
    }
  }
  if (end >= Math.min(text.length, MAX_DECLARATION_TEXT))
    return !complete && text.length < MAX_DECLARATION_TEXT ? 'pending' : 'rejected'
  const source = text.slice(0, end + 1)
  try {
    const entries: unknown = JSON.parse(source)
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 32) return 'rejected'
    // JSON.parse keeps only the final duplicate member. Reject duplicates before trusting shape.
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}:]/g) ?? []
    const members: Set<string>[] = []
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token === '{') members.push(new Set())
      else if (token === '}') members.pop()
      else if (tokens[index + 1] === ':') {
        const name: string = JSON.parse(token)
        const current = members.at(-1)
        if (!current || current.has(name)) return 'rejected'
        current.add(name)
      }
    }
    const identifier = (value: unknown): value is string =>
      typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)
    const variables = new Set<string>()
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'rejected'
      const fields = entry as Record<string, unknown>
      if (
        Object.keys(fields).some(
          (key) =>
            !['key', 'description', 'required', 'environmentVariable', 'planKeys'].includes(key)
        ) ||
        typeof fields.required !== 'boolean' ||
        typeof fields.environmentVariable !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(fields.environmentVariable) ||
        variables.has(fields.environmentVariable) ||
        (fields.key !== undefined && !identifier(fields.key)) ||
        (fields.description !== undefined &&
          (typeof fields.description !== 'string' || fields.description.trim() === '')) ||
        (fields.planKeys !== undefined &&
          (!Array.isArray(fields.planKeys) ||
            fields.planKeys.length === 0 ||
            fields.planKeys.length > 32 ||
            fields.planKeys.some((key) => !identifier(key)) ||
            new Set(fields.planKeys).size !== fields.planKeys.length))
      )
        return 'rejected'
      // Inspect decoded leaves as ordinary text too: JSON escapes must not hide assignments,
      // tokens or a serialized credential object inside otherwise valid declaration metadata.
      if (
        Object.values(fields)
          .flat()
          .some(
            (value) =>
              typeof value === 'string' && findPackageTextMatch(value, true, false) !== undefined
          )
      )
        return 'rejected'
      variables.add(fields.environmentVariable)
    }
    return 'accepted'
  } catch {
    return 'rejected'
  }
}

export const buildSensitiveContentEvidence = (
  text: string,
  match: PackageTextMatch,
  location: string,
  sourceStorageKey?: string,
  offsetBase = 0
): SensitiveContentEvidence => {
  const start = Math.max(0, match.offset - 160)
  const end = Math.min(text.length, match.offset + match.length + 160)
  const rawContext = text.slice(start, end)
  const context = redactSensitiveText(rawContext).slice(0, 800)
  const valueOffset = match.valueOffset ?? match.offset
  const valueLength = match.valueLength ?? match.length
  const rawValue = text.slice(valueOffset, valueOffset + valueLength)
  return {
    location,
    offset: offsetBase + match.offset,
    rule: match.rule,
    matchLength: Math.min(match.length, 10_000),
    ...(match.label ? { label: match.label.slice(0, 200) } : {}),
    leftBoundary: text[match.offset - 1] === undefined ? 'start' : boundary(text[match.offset - 1]),
    rightBoundary:
      text[match.offset + match.length] === undefined
        ? 'end'
        : boundary(text[match.offset + match.length]),
    context,
    ...(rawValue.length <= 10_000 ? { valueLength: rawValue.length } : {}),
    valueHash: createHash('sha256').update(rawValue).digest('hex'),
    ...(sourceStorageKey ? { sourceStorageKey } : {})
  }
}

const findPackageTextMatch = (
  text: string,
  complete: boolean,
  jsonBooleans: boolean,
  beforeText = '',
  declaration?: (index: number, state: DeclarationState) => void
): PackageTextMatch | undefined => {
  const declarationField = (index: number): boolean => {
    if (!jsonBooleans) return false
    while (index > 0 && /[a-z0-9_-]/i.test(text[index - 1])) index--
    const preceding = index === 0 ? beforeText : text[index - 1]
    if (preceding !== '"' && !(index === 0 && /^[a-z0-9_-]$/i.test(preceding))) return false
    const field = /^[a-z0-9_-]+"[ \t\r\n]*:[ \t\r\n]*/i.exec(text.slice(index))
    if (!field) return false
    const rest = text.slice(index + field[0].length)
    if (!rest.startsWith('[')) return false
    const state = credentialDeclarations(rest, complete)
    declaration?.(index, state)
    return state !== 'rejected'
  }
  const booleanField = (index: number): boolean => {
    if (!jsonBooleans) return false
    // Header rules can start at a hyphenated key's suffix; recover the member name
    // before deciding whether its value is a JSON boolean (also across overlaps).
    while (index > 0 && /[a-z0-9_-]/i.test(text[index - 1])) index--
    const preceding = index === 0 ? beforeText : text[index - 1]
    // An overlap may begin at or inside a key. Carry its preceding character so
    // rescanning cannot turn a validated boolean field into an unquoted assignment.
    // The closing quote/colon below and whole-input validation still prove its type.
    if (preceding !== '"' && !(index === 0 && /^[a-z0-9_-]$/i.test(preceding))) return false
    const field = /^[a-z0-9_-]+"[ \t\r\n]*:[ \t\r\n]*/i.exec(text.slice(index))
    if (!field) return false
    const rest = text.slice(index + field[0].length)
    if (/^(?:true|false)[ \t\r\n]*(?=[,}])/.test(rest)) return true
    // This is provisional until the whole JSON/NDJSON input validates. Preserve
    // the original match separately so truncated/invalid input still fails closed.
    const prefix = rest.replace(/[ \t\r\n]+$/, '')
    return !complete && ['true', 'false'].some((literal) => literal.startsWith(prefix))
  }
  const finished = (end: number): boolean =>
    complete || (end < text.length && text.slice(end).trim() !== '')
  const privateValue = (value: string, end: number): boolean => {
    if (!isPrivatePackageValue(value)) return false
    if (finished(end)) return true
    // Only a prefix of an accepted placeholder needs more input. Preserve definite matches
    // before their assignment prefix leaves the bounded streaming overlap.
    const decoded = decodeEscapes(value)
      .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .trimStart()
    const trimmed = decoded.trimEnd()
    if (
      ['Bearer', 'Basic', 'Digest', 'Negotiate'].some((scheme) =>
        scheme.toLowerCase().startsWith(trimmed.toLowerCase())
      )
    )
      return false
    // Whitespace inside an unfinished marker cannot later become the exact [redacted] value.
    // In particular, do not lose a JSON array opener followed by a long whitespace run.
    const bare = decoded
      .replace(/^(?:Bearer|Basic|Digest|Negotiate)\s+/i, '')
      .replace(/\\(?:u[0-9a-f]{0,3})?$/i, '')
      .replace(/%[0-9a-f]?$/i, '')
    return !'[redacted]'.startsWith(bare) && !'%5bredacted%5d'.startsWith(bare.toLowerCase())
  }
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:(?:\\?\/){2}[^\s"'<>]+/gi)) {
    try {
      const rawUrl = match[0]
      const normalizedUrl = rawUrl.replaceAll('\\/', '/')
      const url = new URL(normalizedUrl)
      // This exact documentation example is not a credential. Do not exempt other
      // hosts or values, and still inspect query/fragment credentials below.
      const decodePart = (value: string): string => {
        try {
          return decodeURIComponent(value)
        } catch {
          return value
        }
      }
      const exampleAuthority =
        /^https?:$/.test(url.protocol) &&
        url.hostname === 'host' &&
        url.port === '' &&
        decodePart(url.username) === 'user' &&
        decodePart(url.password) === 'password' &&
        /^\/\.\.\.`?$/.test(decodePart(url.pathname))
      // Delay only an unfinished prefix of the exact example, so split reads do
      // not flag its username before the placeholder host/path arrives.
      const decodedUrl = decodePart(normalizedUrl.replace(/%[0-9a-f]?$/i, ''))
      if (
        !finished(match.index + rawUrl.length) &&
        ['http://user:password@host/...', 'https://user:password@host/...'].some((example) =>
          example.startsWith(decodedUrl)
        )
      )
        continue
      const privatePart = (value: string): boolean => {
        try {
          return privateValue(decodeURIComponent(value), match.index + rawUrl.length)
        } catch {
          return privateValue(value, match.index + rawUrl.length)
        }
      }
      const authorityPrefix = /^[a-z][a-z0-9+.-]*:(?:\\?\/){2}/i.exec(rawUrl)
      if (!authorityPrefix) continue
      const authorityStart = authorityPrefix[0].length
      const authorityEnd = rawUrl.slice(authorityStart).search(/[/?#]/)
      const authority = rawUrl.slice(
        authorityStart,
        authorityEnd < 0 ? rawUrl.length : authorityStart + authorityEnd
      )
      const at = authority.lastIndexOf('@')
      if (at >= 0 && !exampleAuthority) {
        const credentials = authority.slice(0, at)
        const separator = credentials.indexOf(':')
        const usernameLength = separator < 0 ? credentials.length : separator
        const username = credentials.slice(0, usernameLength)
        if (privatePart(username))
          return {
            offset: match.index,
            length: rawUrl.length,
            valueOffset: match.index + authorityStart,
            valueLength: usernameLength,
            rule: 'url',
            label: 'URL'
          }
        if (separator >= 0 && privatePart(credentials.slice(separator + 1)))
          return {
            offset: match.index,
            length: rawUrl.length,
            valueOffset: match.index + authorityStart + separator + 1,
            valueLength: credentials.length - separator - 1,
            rule: 'url',
            label: 'URL'
          }
      }
      const queryRegions: Array<{ start: number; value: string }> = []
      const queryStart = rawUrl.indexOf('?')
      if (queryStart >= 0) {
        const queryEnd = rawUrl.indexOf('#', queryStart)
        queryRegions.push({
          start: queryStart + 1,
          value: rawUrl.slice(queryStart + 1, queryEnd < 0 ? rawUrl.length : queryEnd)
        })
      }
      const fragmentStart = rawUrl.indexOf('#')
      if (fragmentStart >= 0) {
        const fragmentQuery = rawUrl.indexOf('?', fragmentStart)
        queryRegions.push(
          fragmentQuery >= 0
            ? { start: fragmentQuery + 1, value: rawUrl.slice(fragmentQuery + 1) }
            : { start: fragmentStart + 1, value: rawUrl.slice(fragmentStart + 1) }
        )
      }
      for (const region of queryRegions) {
        let cursor = 0
        for (const part of region.value.split('&')) {
          const separator = part.indexOf('=')
          const rawKey = separator < 0 ? part : part.slice(0, separator)
          const rawValue = separator < 0 ? '' : part.slice(separator + 1)
          const decodeQuery = (value: string): string => {
            try {
              return decodeURIComponent(value.replace(/\+/g, ' '))
            } catch {
              return value
            }
          }
          if (isSensitiveUrlQueryKey(decodeQuery(rawKey)) && privatePart(decodeQuery(rawValue)))
            return {
              offset: match.index,
              length: rawUrl.length,
              valueOffset:
                match.index + region.start + cursor + (separator < 0 ? part.length : separator + 1),
              valueLength: rawValue.length,
              rule: 'url',
              label: 'URL'
            }
          cursor += part.length + 1
        }
      }
    } catch {
      /* A malformed/template URL alone is not a credential. */
    }
  }
  for (const match of text.matchAll(/("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*")/g)) {
    try {
      if (
        isSensitiveDiagnosticKey(JSON.parse(match[1])) &&
        isPrivatePackageValue(JSON.parse(match[2]))
      )
        return {
          offset: match.index,
          length: match[0].length,
          valueOffset: match.index + match[0].lastIndexOf(match[2]) + 1,
          valueLength: Math.max(0, match[2].length - 2),
          rule: 'field',
          label: match[1]
        }
    } catch {
      /* Incomplete or invalid JSON is still inspected as text below. */
    }
  }
  for (const match of text.matchAll(
    /\b(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-amz-security-token|cookie|set-cookie)\b\s*["']?\s*:\s*["']?([^"'\r\n}]*)/gi
  )) {
    if (booleanField(match.index) || declarationField(match.index)) continue
    if (privateValue(match[1], match.index + match[0].length))
      return {
        offset: match.index,
        length: match[0].length,
        valueOffset: match.index + match[0].indexOf(match[1]),
        valueLength: match[1].length,
        rule: 'assignment',
        label: match[0].slice(0, match[0].indexOf(match[1])).trim().split(/\s+/)[0]
      }
  }
  // Match prefixes independently so a harmless outer field cannot hide an inner assignment.
  for (const match of text.matchAll(/\b([a-z][a-z0-9_-]*)(\s*["']?\s*[:=]\s*)/gi)) {
    if (!isSensitiveDiagnosticKey(match[1])) continue
    if (booleanField(match.index) || declarationField(match.index)) continue
    const start = match.index + match[0].length
    const rest = text.slice(start)
    // In diagnostics such as `Unexpected token ':'`, the quotes enclose the
    // separator, not a key/value pair. A genuinely quoted key has an opening
    // quote before its name; retain that character across streaming overlaps.
    const separatorQuote = /^\s*(["'])/.exec(match[2])?.[1]
    const preceding = match.index === 0 ? beforeText : text[match.index - 1]
    const partialKey = match.index === 0 && /^[a-z0-9_-]$/i.test(preceding)
    if (separatorQuote && rest[0] === separatorQuote && preceding !== separatorQuote && !partialKey)
      continue
    // These research usage totals are counts, not credentials. The structured policy is
    // provisional until the entire JSON/NDJSON validates; the original match is retained
    // by PackageTextScanner so invalid/truncated input still fails closed.
    if (
      jsonBooleans &&
      numericTokenUsageKeys.some((key) => key === match[1]) &&
      text[match.index - 1] === '"' &&
      /^"[ \t\r\n]*:[ \t\r\n]*$/.test(match[2])
    ) {
      const count = /^(0|[1-9]\d{0,15})[ \t\r\n]*(?=[,}]|$)/.exec(rest)
      if (
        count &&
        Number.isSafeInteger(Number(count[1])) &&
        (count[0].length < rest.length || !complete)
      )
        continue
    }
    // Serialized context/model usage counts are numbers, not credentials. Keep this exception
    // limited to the exact JSON metric keys and integer values, never quoted secrets.
    if (
      text[match.index - 1] === '"' &&
      /^(?:estimatedTokens|tokens|cacheTokens|cachedReadTokens|cachedWriteTokens)"\s*:\s*$/.test(
        match[0]
      )
    ) {
      const count = /^(0|[1-9]\d{0,15})\s*(?=[,}]|$)/.exec(rest)
      if (
        count &&
        Number.isSafeInteger(Number(count[1])) &&
        (count[0].length < rest.length || !complete)
      )
        continue
    }
    const quoted = /^(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/.exec(rest)
    const partialQuoted = !complete && !quoted ? /^(["'])([^\r\n]*)$/.exec(rest) : null
    const value =
      quoted ??
      partialQuoted ??
      /^(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?[^"'&;}\r\n]+/i.exec(rest)
    if (!value) continue
    let content = quoted ? value[0].slice(1, -1) : partialQuoted ? value[0].slice(1) : value[0]
    if (quoted?.[1] === '"') {
      try {
        content = JSON.parse(value[0])
      } catch {
        /* Inspect literal text. */
      }
    }
    // Query values are percent-encoded; decode before recognizing the exact placeholder.
    try {
      content = decodeURIComponent(content)
    } catch {
      /* Inspect literal text. */
    }
    if (privateValue(content, start + value[0].length)) {
      const quotedValue = quoted || partialQuoted
      return {
        offset: match.index,
        length: match[0].length + value[0].length,
        valueOffset: start + (quotedValue ? 1 : 0),
        valueLength: quotedValue
          ? Math.max(0, value[0].length - (quoted ? 2 : 1))
          : value[0].length,
        rule: 'assignment',
        label: match[1]
      }
    }
  }
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}\p{M}_-])--?([a-z][a-z0-9_-]*)(?:\s+|=)(["'](?:\\.|[^"'\\\r\n])*["']|["'][^\r\n]*$|(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?[^\s"'&;]+)/giu
  )) {
    if (!isSensitiveDiagnosticKey(match[1])) continue
    const value = match[2].replace(/^(["'])(.*)\1$/, '$2').replace(/^["']/, '')
    if (privateValue(value, match.index + match[0].length)) {
      const quotedValue = /^['"]/.test(match[2])
      return {
        offset: match.index,
        length: match[0].length,
        valueOffset: match.index + match[0].indexOf(match[2]) + (quotedValue ? 1 : 0),
        valueLength: quotedValue ? Math.max(0, match[2].length - 2) : match[2].length,
        rule: 'assignment',
        label: `-${match[1]}`
      }
    }
  }
  for (const match of text.matchAll(
    /\bBearer\s+[^\s"']+|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/gi
  )) {
    // Nested JSON adds matching escape runs to the surrounding quotes. Exclude only those
    // delimiters from an exact placeholder, never literal backslashes in a credential value.
    const end = match.index + match[0].length
    let openingEscapes = 0
    if (text[match.index - 1] === '"')
      while (text[match.index - 2 - openingEscapes] === '\\') openingEscapes++
    let closingEscapes = 0
    while (text[end - 1 - closingEscapes] === '\\') closingEscapes++
    if (
      openingEscapes % 2 === 1 &&
      closingEscapes > 0 &&
      !isPrivatePackageValue(match[0].slice(0, -closingEscapes)) &&
      ((closingEscapes === openingEscapes && text[end] === '"') ||
        (!complete && end === text.length && closingEscapes <= openingEscapes))
    )
      continue
    if (privateValue(match[0], match.index + match[0].length))
      return {
        offset: match.index,
        length: match[0].length,
        valueOffset: match.index,
        valueLength: match[0].length,
        rule: 'token',
        label: 'token pattern'
      }
  }
  return undefined
}

export const findSensitivePackageText = (
  text: string,
  complete = true
): PackageTextMatch | undefined => {
  if (!complete) return findPackageTextMatch(text, false, true)
  const syntax = new PackageJsonSyntax()
  syntax.write(text)
  return findPackageTextMatch(text, true, syntax.finish())
}

type TextFinding = { text: string; match: PackageTextMatch; offset: number }

// Keep validation, overlap and both candidate policies under one stream owner.
// Structured field exceptions are exempt only after the entire file validates.
export class PackageTextScanner {
  private readonly syntax = new PackageJsonSyntax()
  private tail = ''
  private beforeTail = ''
  private offset = 0
  private original?: TextFinding
  private structured?: TextFinding
  private readonly pendingDeclarations = new Set<number>()
  private declarationOverflow = false

  write(decoded: string, complete = false): void {
    this.syntax.write(decoded)
    const text = this.tail + decoded
    const inspect = (jsonBooleans: boolean): TextFinding | undefined => {
      const match = findPackageTextMatch(
        text,
        complete,
        jsonBooleans,
        this.beforeTail,
        (index, state) => {
          const absolute = this.offset - this.tail.length + index
          if (state === 'pending') {
            if (this.pendingDeclarations.size >= 32 && !this.pendingDeclarations.has(absolute))
              this.declarationOverflow = true
            else this.pendingDeclarations.add(absolute)
          } else this.pendingDeclarations.delete(absolute)
        }
      )
      return match ? { text, match, offset: this.offset - this.tail.length } : undefined
    }
    this.original ??= inspect(false)
    if (this.original) this.structured ??= inspect(true)
    this.offset += decoded.length
    let tailStart = Math.max(0, text.length - 8192)
    // Retain a whole allowlisted count key if the overlap would split it. Its suffix
    // alone cannot prove an exact key match, and must never gain a broader exception.
    // This adds at most one bounded key to the existing overlap, not its value.
    for (const key of numericTokenUsageKeys) {
      const quoted = `"${key}"`
      const start = text.lastIndexOf(quoted, tailStart)
      if (start >= 0 && start < tailStart && start + quoted.length > tailStart) tailStart = start
    }
    if (tailStart > 0) this.beforeTail = text[tailStart - 1]
    this.tail = text.slice(tailStart)
  }

  finish(): TextFinding | undefined {
    this.write('', true)
    return this.syntax.finish() && !this.declarationOverflow && this.pendingDeclarations.size === 0
      ? this.structured
      : this.original
  }
}

export class PackageSensitiveContentError extends Error {
  readonly location: string
  constructor(
    location: string,
    readonly rule: PackageTextMatch['rule'],
    readonly evidence?: SensitiveContentEvidence,
    readonly source?: PackageSensitiveContentSource
  ) {
    // Location contains no matched values. Bound and redact user-controlled filenames/keys.
    const safe = Array.from(redactSensitiveText(location).slice(0, 800), (char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '?' : char
    ).join('')
    super(`Sensitive content detected at ${safe}.`)
    this.location = safe
  }
}
