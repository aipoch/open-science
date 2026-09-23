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

export type PackageTextMatch = {
  offset: number
  length: number
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
  const rawMatch = text.slice(match.offset, match.offset + match.length)
  return {
    location,
    offset: offsetBase + match.offset,
    rule: match.rule,
    matchLength: match.length,
    ...(match.label ? { label: match.label } : {}),
    leftBoundary: text[match.offset - 1] === undefined ? 'start' : boundary(text[match.offset - 1]),
    rightBoundary:
      text[match.offset + match.length] === undefined
        ? 'end'
        : boundary(text[match.offset + match.length]),
    context,
    valueLength: rawMatch.length,
    valueHash: createHash('sha256').update(rawMatch).digest('hex'),
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
      const url = new URL(match[0].replaceAll('\\/', '/'))
      const privatePart = (value: string): boolean => {
        try {
          return privateValue(decodeURIComponent(value), match.index + match[0].length)
        } catch {
          return privateValue(value, match.index + match[0].length)
        }
      }
      const fragment = url.hash.slice(1)
      const query = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment
      if (
        privatePart(url.username) ||
        privatePart(url.password) ||
        [...url.searchParams, ...new URLSearchParams(query)].some(
          ([key, value]) =>
            isSensitiveUrlQueryKey(key) && privateValue(value, match.index + match[0].length)
        )
      )
        return { offset: match.index, length: match[0].length, rule: 'url', label: 'URL' }
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
        return { offset: match.index, length: match[0].length, rule: 'field', label: match[1] }
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
        rule: 'assignment',
        label: match[1]
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
    if (privateValue(content, start + value[0].length))
      return {
        offset: match.index,
        length: match[0].length + value[0].length,
        rule: 'assignment',
        label: match[1]
      }
  }
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}\p{M}_-])--?([a-z][a-z0-9_-]*)(?:\s+|=)(["'](?:\\.|[^"'\\\r\n])*["']|["'][^\r\n]*$|(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?[^\s"'&;]+)/giu
  )) {
    if (!isSensitiveDiagnosticKey(match[1])) continue
    const value = match[2].replace(/^(["'])(.*)\1$/, '$2').replace(/^["']/, '')
    if (privateValue(value, match.index + match[0].length))
      return {
        offset: match.index,
        length: match[0].length,
        rule: 'assignment',
        label: `-${match[1]}`
      }
  }
  for (const match of text.matchAll(
    /\bBearer\s+[^\s"']+|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/gi
  )) {
    if (privateValue(match[0], match.index + match[0].length))
      return { offset: match.index, length: match[0].length, rule: 'token', label: 'token pattern' }
  }
  return undefined
}

export class PackageSensitiveContentError extends Error {
  readonly location: string
  constructor(
    location: string,
    readonly rule: PackageTextMatch['rule'],
    readonly evidence?: SensitiveContentEvidence
  ) {
    // Location contains no matched values. Bound and redact user-controlled filenames/keys.
    const safe = Array.from(redactSensitiveText(location).slice(0, 800), (char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '?' : char
    ).join('')
    super(`Sensitive content detected at ${safe}.`)
    this.location = safe
  }
}
