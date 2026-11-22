import { redactSensitiveText } from '@aipoch/diagnostics'
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

// Export blocks on a credential position. Diagnostic logs also redact business
// names containing sensitive words, which is deliberately a broader policy.
const credentialKeyPatterns = [
  /^(?:apiSecret|api_secret|api-secret|API_SECRET)$/,
  /^(?:oauth|oidc)[_-]?signatures?$/i,
  /^(?:auth|authentication|authorization|bearer|cookies?|credentials?|passwords?|passphrases?|passwd|pat|secrets?|tokens?)$/i,
  /^(?:(?:api|access|private|secret)[_-]?keys?|(?:aws[_-]?)?secret[_-]?access[_-]?key|(?:client|jwt|signing)[_-]?secrets?)$/i,
  /^(?:proxy[_-]?authorization|set[_-]?cookie|x[_-]?(?:api[_-]?key|auth[_-]?token|amz[_-]?security[_-]?token))$/i,
  /^(?:gh|github|hf|session)[_-]?tokens?$/i
]

// Business names can end in "token", "session token" or "secret". Only a
// credential-specific suffix supplies enough evidence to flag an opaque value.
const credentialToken =
  /(?:^|[_-])(?:access|api|auth|authentication|authorization|bearer|id|oauth|personal[_-]?access|private|refresh|secret|security)[_-]?tokens?$/i
const qualifiedCredentialSuffixes = [
  /_(?:passwords?|passwd|passphrases?)$/,
  /_(?:(?:api|access|private|secret)_?keys?|access_?key_?id|secret_?access_?key)$/,
  /_(?:api|client|jwt|signing)_?secrets?$/,
  /_(?:oauth|oidc)_?signatures?$/,
  /_rpc_?tokens?$/,
  /(?:^|_)headers?_(?:authorization|proxy_authorization|cookies?|set_cookie)$/,
  /(?:^|_)(?:aws|auth|authentication|oauth|oidc)_session_?tokens?$/
]

const normalizeFieldName = (key: string): string =>
  key
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toLowerCase()

const isCredentialKey = (key: string): boolean => {
  key = key.trim().replace(/\s+/g, '_')
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i.test(key)) return false
  // A value wrapper inherits the underlying field's meaning. Strip one complete
  // word, preserving spelling for the exact credential rules below.
  key = key.replace(/(?:[._-](?:[Vv]alues?|VALUES?)|Values?)$/, '').replaceAll('.', '_')
  if (credentialKeyPatterns.some((rule) => rule.test(key))) return true
  const words = normalizeFieldName(key)
  // Both predicates and token quantities can follow a business namespace.
  if (/(?:^|_)(?:has|is|no|needs|requires|supports)_/.test(words)) return false
  if (
    words.endsWith('_tokens') &&
    /(?:^|_)(?:min|max|count|total|remaining|limit|budget)_/.test(words)
  )
    return false
  // These protocol headers carry credentials, including when qualified by a
  // namespace. A header name, label or template ends in a different word.
  if (
    /(?:^|_)(?:authorization|cookies?|api_key|x_auth_token|x_amz_security_token)_header$/.test(
      words
    )
  )
    return true
  return (
    credentialToken.test(key) ||
    credentialToken.test(words) ||
    qualifiedCredentialSuffixes.some((rule) => rule.test(words))
  )
}

export const isPrivatePackageField = (key: string, value: string): boolean =>
  isCredentialKey(key) && isPrivatePackageValue(value)

const jsonStringMembers = /("(?:\\.|[^"\\])*")(?:\s*:\s*("(?:\\.|[^"\\])*"))?/g
// A quote after a backslash cannot open a string in a JSON document. A scan
// window starting inside a string can otherwise read escaped quotes as new members.
const structuredStringMembers = new RegExp('(?<!\\\\)' + jsonStringMembers.source, 'g')
const structuredCredentialHint =
  /(?:api|auth|bearer|cookie|credential|password|passphrase|passwd|pat|secret|token|access|private|oauth|oidc|key|signature)/i
const escapedAsciiHint = /\\u00(?:[2-7][0-9a-f])/i
const credentialValueHint =
  /(?:\b(?:gh[pousr]_\w+|github_pat_\w+|AKIA[0-9A-Z]+|eyJ[0-9A-Za-z_-]+|sk-[0-9A-Za-z_-]+)|\bBearer\b)/i
const credentialScanHint = /(?:[a-z][a-z0-9+.-]*:(?:\\?\/){2}|[?&#][^=&\s]+=[^&\s]+)/i
const structuredCredentialWords = [
  'api',
  'auth',
  'bearer',
  'cookie',
  'credential',
  'password',
  'passphrase',
  'passwd',
  'pat',
  'secret',
  'token',
  'access',
  'private',
  'oauth',
  'oidc',
  'key',
  'signature'
]

const mayContainStructuredCredential = (text: string): boolean =>
  structuredCredentialHint.test(text) || escapedAsciiHint.test(text)

const mayContainCredential = (text: string): boolean => {
  if (text.length > 16 * 1024) {
    const lower = text.toLowerCase()
    if (structuredCredentialWords.some((word) => lower.includes(word))) return true
    if (lower.includes('://') || lower.includes('?') || lower.includes('#') || lower.includes('&'))
      return true
    if (lower.includes('\\u00') && escapedAsciiHint.test(text)) return true
    return credentialValueHint.test(text)
  }
  return (
    mayContainStructuredCredential(text) ||
    credentialValueHint.test(text) ||
    credentialScanHint.test(text)
  )
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
  const valueOffset = match.valueOffset ?? match.offset
  const valueLength = match.valueLength ?? match.length
  const rawValue = text.slice(valueOffset, valueOffset + valueLength)
  // An encoded credential can occur under any key. Mask the exact source span
  // before applying the independent log redactor to the surrounding context.
  const context = redactSensitiveText(
    text.slice(start, valueOffset) + '[redacted]' + text.slice(valueOffset + valueLength, end)
  ).slice(0, 800)
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
  beforeText = '',
  inspectEncodedValues = true
): PackageTextMatch | undefined => {
  const nonCredentialField = (index: number): boolean => {
    if (!jsonMetadata) return false
    // Header rules can start at a hyphenated key's suffix; recover the member name
    // before deciding whether its value is a JSON boolean (also across overlaps).
    while (index > 0 && /[a-z0-9_.-]/i.test(text[index - 1])) index--
    const preceding = index === 0 ? beforeText.slice(-1) : text[index - 1]
    // An overlap may begin at or inside a key. Carry its preceding character so
    // rescanning cannot turn a validated boolean field into an unquoted assignment.
    // The closing quote/colon below and whole-input validation still prove its type.
    if (preceding !== '"' && !(index === 0 && /^[a-z0-9_.-]$/i.test(preceding))) return false
    const field = /^[a-z0-9_.-]+"[ \t\r\n]*:[ \t\r\n]*/i.exec(text.slice(index))
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
  const decodedCredential = (raw: string, decoded: string, closed: boolean): boolean =>
    inspectEncodedValues && raw !== decoded && Boolean(scanPackageText(decoded, closed, false))
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
          const key = decodeQuery(rawKey)
          const value = decodeQuery(rawValue)
          const credentialParameter =
            isCredentialKey(key) ||
            /^(?:key|username|sig|signature|(?:oauth|oidc)[_-]?signature|x-(?:amz|goog)-signature)$/i.test(
              key
            )
          if (
            (credentialParameter && privatePart(value)) ||
            decodedCredential(
              rawValue,
              value,
              finished(match.index + region.start + cursor + part.length)
            )
          )
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
  // Inspect decoded JSON strings in both object fields and array elements.
  for (const match of text.matchAll(jsonMetadata ? structuredStringMembers : jsonStringMembers)) {
    const literal = match[2] ?? match[1]
    if (!match[2] && !literal.includes('\\')) continue
    try {
      const value: string = JSON.parse(literal)
      if (
        (match[2] && isPrivatePackageField(JSON.parse(match[1]), value)) ||
        decodedCredential(literal.slice(1, -1), value, true)
      )
        return {
          offset: match.index,
          length: match[0].length,
          valueOffset: match.index + match[0].lastIndexOf(literal) + 1,
          valueLength: literal.length - 2,
          rule: match[2] ? 'field' : 'token',
          ...(match[2] ? { label: match[1] } : {})
        }
    } catch {
      /* Incomplete or invalid JSON is still inspected as text below. */
    }
  }
  for (const match of text.matchAll(
    /(?<![a-z0-9_.-])(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-amz-security-token|cookie|set-cookie)\b\s*(?:["']\s*)?:\s*["']?([^"'\r\n}]*)/gi
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
    /(?:\\+[rn]|\b)([a-z][a-z0-9_.-]*(?:[ \t]+[a-z][a-z0-9_.-]*)*)(?:[ \t]*\[[ \t]*(?:\\*["'][a-z0-9_.-]+\\*["']|[a-z0-9_]+)[ \t]*\])*(\s*(?:["']\s*)?[:=]\s*)/gi
  )) {
    // A literal indexed write can identify a credential inside an ordinary object.
    let key = match[1]
    if (!isCredentialKey(key)) {
      if (!match[0].includes('[')) continue
      for (const index of match[0].matchAll(/\[[ \t]*\\*["']([a-z0-9_.-]+)\\*["']/gi)) {
        if (isCredentialKey(index[1])) {
          key = index[1]
          break
        }
      }
      if (!isCredentialKey(key)) continue
    }
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
      if (/^[ \t\r\n]{0,512}(?:[;}]|$)|^"(?:[},]|$)/.test(tail)) return true
      // A following assignment is a separate statement, including indexed writes.
      const nextAssignment =
        /^[ \t]*[\r\n][ \t\r\n]*[a-zA-Z_][a-zA-Z0-9_]*(?:[ \t]*\[[ \t]*(?:["'][a-zA-Z0-9_]+["']|[a-zA-Z0-9_]+)[ \t]*\])*[ \t]*=(?!=)/.exec(
          tail
        )
      if (nextAssignment && nextAssignment[0].length <= 512) return true
      // Named calls start another statement; word operators can still continue this one.
      const nextCall =
        /^[ \t]*[\r\n][ \t\r\n]*([a-zA-Z_$][a-zA-Z0-9_$]*)(?:[ \t]*\.[ \t]*[a-zA-Z_$][a-zA-Z0-9_$]*)*[ \t]*\(/.exec(
          tail
        )
      if (
        nextCall &&
        nextCall[0].length <= 512 &&
        !/^(?:and|or|not|is|in|instanceof|if|else|as|satisfies)$/.test(nextCall[1])
      )
        return true
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
    // A bare "tokens" member can also be a usage count. Accept that JSON
    // spelling only with an unquoted nonnegative safe integer.
    if (preceding === '"' && /^tokens"\s*:\s*$/.test(match[0])) {
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
    if (isPrivatePackageField(key, content) && privateValue(content, start + value[0].length)) {
      const quotedValue = quoted || partialQuoted
      return {
        offset: match.index,
        length: match[0].length + value[0].length,
        valueOffset: start + (quotedValue ? 1 : 0),
        valueLength: quotedValue
          ? Math.max(0, value[0].length - (quoted ? 2 : 1))
          : value[0].length,
        rule: 'assignment',
        label: key
      }
    }
  }
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}\p{M}_-])--?([a-z][a-z0-9_.-]*)(?:\s+|=)(["'](?:\\.|[^"'\\\r\n])*["']|["'][^\r\n]*$|(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?[^\s"'&;]+)/giu
  )) {
    if (!isCredentialKey(match[1])) continue
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

const scanPackageText = (
  text: string,
  complete: boolean,
  inspectEncodedValues: boolean
): PackageTextMatch | undefined => {
  if (!mayContainCredential(text)) return undefined
  if (!complete) return findPackageTextMatch(text, false, true, '', inspectEncodedValues)
  const syntax = new PackageJsonSyntax()
  syntax.write(text)
  return findPackageTextMatch(text, true, syntax.finish(), '', inspectEncodedValues)
}

export const findSensitivePackageText = (
  text: string,
  complete = true
): PackageTextMatch | undefined => scanPackageText(text, complete, true)

type TextFinding = { text: string; match: PackageTextMatch; offset: number }

const retainedWindowStart = (text: string): number => {
  // Keep short identifiers whole so a business key's suffix cannot become a credential.
  const cut = Math.max(0, text.length - 8192)
  const prefix = text.slice(Math.max(0, cut - 512), cut).match(/[\w%.\\-]+$/)?.[0] ?? ''
  return cut - prefix.length
}

// When a window ends in a credential name or separator followed by whitespace,
// retain just the unfinished assignment and the context needed by the code rules.
const pendingStringAssignment = (discarded: string): string => {
  const end = discarded.trimEnd()
  if (!end) return ''
  const separator = /[:=]$/.test(end) ? end.slice(-1) : ''
  const name = (separator ? end.slice(0, -1).trimEnd() : end).slice(-1025)
  const match = /(?:^|[^\w.-])([a-z][\w.-]*)(["']?)$/i.exec(name)
  if (!match || match[1].length > 512 || !isCredentialKey(match[1])) return ''
  return name.slice(Math.max(0, match.index - 511)) + separator + ' '
}

// Every JSON escape represents one UTF-16 code unit. Translate only offsets
// that we retain or report so evidence always refers to the original file.
const jsonStringSourceOffset = (source: string, offset: number): number => {
  for (const escape of source.matchAll(/\\(?:u[0-9a-fA-F]{4}|.)/g)) {
    if (escape.index >= offset) break
    offset += escape[0].length - 1
  }
  return offset
}

// Keep validation, overlap and both candidate policies under one stream owner.
// Typed metadata exemptions apply only after the entire file validates.
export class PackageTextScanner {
  private readonly syntax = new PackageJsonSyntax()
  private tail = ''
  private beforeTail = ''
  private offset = 0
  private original?: TextFinding
  private structured?: TextFinding
  private stringTail = ''
  private pendingAssignment = ''
  private encoded?: TextFinding
  private scanCredentialTail = false

  private inspectString(
    source: string,
    offset: number,
    closed: boolean,
    pendingEscape: number
  ): void {
    // Complete literals within one read are covered by the ordinary text scan.
    if (this.encoded || (closed && !this.stringTail)) return
    const raw = this.stringTail + source
    offset -= this.stringTail.length
    const safe = raw.slice(0, raw.length - pendingEscape)
    if (!this.pendingAssignment && !mayContainCredential(safe)) {
      this.pendingAssignment = ''
      this.stringTail = closed ? '' : raw.slice(-8192)
      return
    }
    const escaped = safe.includes('\\')
    const value: string = escaped ? JSON.parse('"' + safe + '"') : safe
    const cut = closed ? value.length : retainedWindowStart(value)
    const prefix = this.pendingAssignment
    const window = prefix + value
    if ((escaped || prefix) && cut > 0) {
      const match = scanPackageText(window, closed, false)
      const valueStart = match && (match.valueOffset ?? match.offset) - prefix.length
      if (
        match &&
        valueStart !== undefined &&
        valueStart >= 0 &&
        match.offset < prefix.length + cut
      ) {
        // If the key has left the source window, anchor evidence at its real
        // value. Never hash synthetic whitespace or include it in a file offset.
        const start = jsonStringSourceOffset(
          safe,
          match.offset < prefix.length ? valueStart : match.offset - prefix.length
        )
        const valueOffset = jsonStringSourceOffset(safe, valueStart)
        this.encoded = {
          text: safe,
          offset,
          match: {
            ...match,
            offset: start,
            length:
              jsonStringSourceOffset(safe, match.offset + match.length - prefix.length) - start,
            valueOffset,
            valueLength:
              jsonStringSourceOffset(safe, valueStart + (match.valueLength ?? match.length)) -
              valueOffset
          }
        }
      }
    }
    if (closed) this.pendingAssignment = ''
    else if (cut > 0) {
      const boundary = prefix.length + cut
      this.pendingAssignment =
        /\s/.test(window[boundary - 1]) || /\s/.test(window[boundary])
          ? pendingStringAssignment(window.slice(0, boundary))
          : ''
    }
    this.stringTail = closed ? '' : raw.slice(escaped ? jsonStringSourceOffset(safe, cut) : cut)
  }

  write(decoded: string, complete = false): void {
    this.syntax.write(decoded, (start, end, closed, pendingEscape) =>
      this.inspectString(decoded.slice(start, end), this.offset + start, closed, pendingEscape)
    )
    const text = this.tail + decoded
    const inspect = (jsonMetadata: boolean): TextFinding | undefined => {
      const match = findPackageTextMatch(text, complete, jsonMetadata, this.beforeTail)
      return match ? { text, match, offset: this.offset - this.tail.length } : undefined
    }
    this.scanCredentialTail ||= mayContainCredential(text)
    if (!this.original && this.scanCredentialTail) this.original = inspect(false)
    if (!this.structured && this.scanCredentialTail) this.structured = inspect(true)
    this.offset += decoded.length
    const start = retainedWindowStart(text)
    if (start > 0) this.beforeTail = (this.beforeTail + text.slice(0, start)).slice(-512)
    this.tail = text.slice(start)
  }

  finish(): TextFinding | undefined {
    this.write('', true)
    return (this.syntax.finish() ? this.structured : this.original) ?? this.encoded
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
