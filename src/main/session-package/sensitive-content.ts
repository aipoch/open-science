import {
  isSensitiveDiagnosticKey,
  isSensitiveUrlQueryKey,
  redactSensitiveText
} from '@aipoch/diagnostics'
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

// Only exempt a known authentication scheme; identifier-shaped values can still be secrets.
export const isPrivatePackageField = (key: string, value: string): boolean => {
  if (!isSensitiveDiagnosticKey(key) || !isPrivatePackageValue(value)) return false
  if (/^(?:token_type|tokenType)$/.test(key) && /^(?:Bearer|bearer)$/.test(value)) return false
  return true
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
  jsonMetadata: boolean,
  beforeText = ''
): PackageTextMatch | undefined => {
  const nonCredentialField = (index: number): boolean => {
    if (!jsonMetadata) return false
    // Header rules can start at a hyphenated key's suffix; recover the member name
    // before deciding whether its value is a JSON boolean (also across overlaps).
    while (index > 0 && /[a-z0-9_-]/i.test(text[index - 1])) index--
    const preceding = index === 0 ? beforeText.slice(-1) : text[index - 1]
    // An overlap may begin at or inside a key. Carry its preceding character so
    // rescanning cannot turn a validated boolean field into an unquoted assignment.
    // The closing quote/colon below and whole-input validation still prove its type.
    if (preceding !== '"' && !(index === 0 && /^[a-z0-9_-]$/i.test(preceding))) return false
    const field = /^[a-z0-9_-]+"[ \t\r\n]*:[ \t\r\n]*/i.exec(text.slice(index))
    if (!field) return false
    const rest = text.slice(index + field[0].length)
    if (/^(?:true|false|null|\[[ \t\r\n]*\]|\{[ \t\r\n]*\})[ \t\r\n]*(?=[,}])/.test(rest))
      return true
    // This is provisional until the whole JSON/NDJSON input validates. Preserve
    // the original match separately so truncated/invalid input still fails closed.
    const prefix = rest.replace(/[ \t\r\n]+/g, '')
    return (
      !complete &&
      (['true', 'false', 'null', '[]', '{}'].some((literal) => literal.startsWith(prefix)) ||
        /^[[{][ \t\r\n]*$/.test(rest))
    )
  }
  const finished = (end: number): boolean =>
    complete || (end < text.length && text.slice(end).trim() !== '')
  const privateValue = (value: string, end: number): boolean => {
    if (!isPrivatePackageValue(value)) return false
    if (finished(end)) return true
    // Only a prefix of an accepted placeholder needs more input. Preserve definite matches
    // before their assignment prefix leaves the bounded streaming overlap.
    const trimmed = decodeEscapes(value)
      .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .trimStart()
    if (
      ['Bearer', 'Basic', 'Digest', 'Negotiate'].some((scheme) =>
        scheme.toLowerCase().startsWith(trimmed.toLowerCase())
      )
    )
      return false
    const bare = trimmed
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
      if (isPrivatePackageField(JSON.parse(match[1]), JSON.parse(match[2])))
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
    if (nonCredentialField(match.index)) continue
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
  for (const match of text.matchAll(
    /(?:\\+[rn]|\b)([a-z][a-z0-9_-]*)(?:[ \t]*\[[ \t]*(?:\\*["'][a-z0-9_-]+\\*["']|[a-z0-9_]+)[ \t]*\])*(\s*["']?\s*[:=]\s*)/gi
  )) {
    if (!isSensitiveDiagnosticKey(match[1])) continue
    if (nonCredentialField(match.index)) continue
    // A Python loop's iterable is not a credential assignment. Inspect only the
    // header prefix; credentials in its body still pass through every recognizer.
    // shortcut: headers longer than 512 characters remain conservative until needed.
    const precedingCode = (beforeText + text.slice(Math.max(0, match.index - 512), match.index))
      .slice(-512)
      .replace(/\\+[rn]/g, '\n')
    if (
      /^[ \t]*:/.test(match[2]) &&
      /\b(?:for[ \t]+(?:[a-zA-Z_][a-zA-Z0-9_]*(?:[ \t]*,[ \t]*[a-zA-Z_][a-zA-Z0-9_]*)*|\([ \t]*[a-zA-Z_][a-zA-Z0-9_]*(?:[ \t]*,[ \t]*[a-zA-Z_][a-zA-Z0-9_]*)*[ \t]*,?[ \t]*\))[ \t]+in|(?:if|elif|while)(?:[ \t]+not)?)[ \t]+$/.test(
        precedingCode
      )
    )
      continue
    const start = match.index + match[0].length
    const rest = text.slice(start)
    // Newlines alone cannot terminate JavaScript expressions; serialized code follows
    // the same bounded check so a later operator cannot hide a literal credential.
    const expression = rest.replace(/\\+"/g, '"').replace(/\\+[rn]/g, '\n')
    const expressionEndsAt = (end: number): boolean => {
      const tail = expression.slice(end)
      if (/^[ \t\r\n]{0,512}(?:[,;}]|$)|^"(?:[},]|$)/.test(tail)) return true
      // A following assignment is a separate statement, including indexed writes.
      const nextAssignment =
        /^[ \t]*[\r\n][ \t\r\n]*[a-zA-Z_][a-zA-Z0-9_]*(?:[ \t]*\[[ \t]*(?:["'][a-zA-Z0-9_]+["']|[a-zA-Z0-9_]+)[ \t]*\])*[ \t]*=(?!=)/.exec(
          tail
        )
      if (nextAssignment && nextAssignment[0].length <= 512) return true
      // Keep an incomplete next statement provisional only within the overlap.
      return !complete && tail.length <= 512 && /^[ \t]*(?:[\r\n]|\\+$)/.test(tail)
    }
    // Comparisons and arrow syntax do not assign a credential value.
    const comparison = /^(?:={1,2}|>)[ \t]{0,512}[a-zA-Z_][a-zA-Z0-9_.]{0,127}/.exec(expression)
    if (
      match[2].trim() === '=' &&
      ((comparison && expressionEndsAt(comparison[0].length)) ||
        (!complete && /^(?:={1,2}|>)[ \t]{0,512}$/.test(rest)))
    )
      continue
    // Empty collections contain no credential. Defer incomplete collection prefixes
    // but still inspect any nonempty contents, including nested literal secrets.
    const emptyCollection = /^(?:\[[ \t]*\]|\{[ \t]*\})/.exec(expression)
    if (
      match[2].trim() === '=' &&
      ((emptyCollection && expressionEndsAt(emptyCollection[0].length)) ||
        (!complete && rest.length <= 512 && /^[[{][ \t]*$/.test(rest)))
    )
      continue
    // Prove a reference without evaluating code; defaults and compound expressions
    // remain candidates. A bounded preview's end is not an expression terminator.
    const reference =
      /^(?:os\.environ\[["'][A-Z_][A-Z0-9_]*["']\]|os\.(?:getenv|environ\.get)\(["'][A-Z_][A-Z0-9_]*["']\)|process\.env\.[A-Z_][A-Z0-9_]*)/.exec(
        expression
      )
    if (
      match[2].trim() === '=' &&
      reference &&
      reference[0].length <= 512 &&
      expressionEndsAt(reference[0].length)
    )
      continue
    if (
      !complete &&
      rest.length <= 512 &&
      match[2].trim() === '=' &&
      (['os.environ[', 'os.getenv(', 'os.environ.get(', 'process.env.'].some((prefix) =>
        prefix.startsWith(expression.replace(/\\+$/, ''))
      ) ||
        /^(?:os\.(?:environ\[|getenv\(|environ\.get\()["']?(?:[A-Z_][A-Z0-9_]*)?["']?|process\.env\.[A-Z_][A-Z0-9_]*)$/.test(
          expression.replace(/\\+$/, '')
        ))
    )
      continue
    // A primitive annotation is safe only in a declaration and without a default.
    if (
      match[2].trim() === ':' &&
      /\b(?:def[ \t]+[a-zA-Z_][a-zA-Z0-9_]*\([^()\r\n]*|(?:const|let|var)[ \t]+)$/.test(
        precedingCode
      ) &&
      (/^(?:str|int|float|bool|bytes|string|number|boolean)(?=[ \t]*[,);\r\n]|$)/.test(rest) ||
        (!complete &&
          ['str', 'int', 'float', 'bool', 'bytes', 'string', 'number', 'boolean'].some((type) =>
            type.startsWith(rest)
          )))
    )
      continue
    // In diagnostics such as `Unexpected token ':'`, the quotes enclose the
    // separator, not a key/value pair. A genuinely quoted key has an opening
    // quote before its name; retain that character across streaming overlaps.
    const separatorQuote = /^\s*(["'])/.exec(match[2])?.[1]
    const preceding = match.index === 0 ? beforeText.slice(-1) : text[match.index - 1]
    const partialKey = match.index === 0 && /^[a-z0-9_-]$/i.test(preceding)
    if (separatorQuote && rest[0] === separatorQuote && preceding !== separatorQuote && !partialKey)
      continue
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
    if (
      isPrivatePackageField(match[1], content) &&
      privateValue(content, start + value[0].length)
    ) {
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
// Typed metadata exemptions apply only after the entire file validates.
export class PackageTextScanner {
  private readonly syntax = new PackageJsonSyntax()
  private tail = ''
  private beforeTail = ''
  private offset = 0
  private original?: TextFinding
  private structured?: TextFinding

  write(decoded: string, complete = false): void {
    this.syntax.write(decoded)
    const text = this.tail + decoded
    const inspect = (jsonMetadata: boolean): TextFinding | undefined => {
      const match = findPackageTextMatch(text, complete, jsonMetadata, this.beforeTail)
      return match ? { text, match, offset: this.offset - this.tail.length } : undefined
    }
    this.original ??= inspect(false)
    if (this.original) this.structured ??= inspect(true)
    this.offset += decoded.length
    if (text.length > 8192) this.beforeTail = (this.beforeTail + text.slice(0, -8192)).slice(-512)
    this.tail = text.slice(-8192)
  }

  finish(): TextFinding | undefined {
    this.write('', true)
    return this.syntax.finish() ? this.structured : this.original
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
