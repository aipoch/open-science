import {
  isSensitiveDiagnosticKey,
  isSensitiveUrlQueryKey,
  redactSensitiveText
} from '../../shared/diagnostic-redaction'
import type { SensitiveContentEvidence } from '../../shared/session-package'
import { createHash } from 'node:crypto'

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

export const findSensitivePackageText = (
  text: string,
  complete = true
): PackageTextMatch | undefined => {
  const finished = (end: number): boolean =>
    complete || (end < text.length && text.slice(end).trim() !== '')
  const privateValue = (value: string, end: number): boolean => {
    if (!isPrivatePackageValue(value)) return false
    if (finished(end)) return true
    // Only a prefix of an accepted placeholder needs more input. Preserve definite matches
    // before their assignment prefix leaves the bounded streaming overlap.
    const trimmed = decodeEscapes(value)
      .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .trim()
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
      new URL(rawUrl.replaceAll('\\/', '/'))
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
      if (at >= 0) {
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
      const fragmentQuery = fragmentStart < 0 ? -1 : rawUrl.indexOf('?', fragmentStart)
      if (fragmentQuery >= 0)
        queryRegions.push({ start: fragmentQuery + 1, value: rawUrl.slice(fragmentQuery + 1) })
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
    const start = match.index + match[0].length
    const rest = text.slice(start)
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
