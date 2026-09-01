type NamedCredentialKind = 'environment' | 'header'

type ParsedNamedValues = {
  values: Record<string, string>
  invalidLines: number[]
  duplicateLines: Array<{ line: number; name: string }>
}

const parseEnvironment = (raw: string, caseInsensitiveNames: boolean): ParsedNamedValues => {
  const values: Record<string, string> = {}
  const invalidLines: number[] = []
  const duplicateLines: ParsedNamedValues['duplicateLines'] = []
  const names = new Set<string>()

  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      invalidLines.push(index + 1)
      continue
    }
    const name = trimmed.slice(0, separator).trim()
    const normalizedName = caseInsensitiveNames ? name.toLowerCase() : name
    if (names.has(normalizedName)) duplicateLines.push({ line: index + 1, name })
    else names.add(normalizedName)
    values[name] = trimmed.slice(separator + 1).trim()
  }

  return { values, invalidLines, duplicateLines }
}

const parseHeaders = (raw: string): ParsedNamedValues => {
  const values: Record<string, string> = {}
  const invalidLines: number[] = []
  const duplicateLines: ParsedNamedValues['duplicateLines'] = []
  const names = new Map<string, string>()

  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) {
      invalidLines.push(index + 1)
      continue
    }
    const name = trimmed.slice(0, separator).trim()
    const normalizedName = name.toLowerCase()
    const previousName = names.get(normalizedName)
    if (previousName) duplicateLines.push({ line: index + 1, name })
    else names.set(normalizedName, name)
    values[previousName ?? name] = trimmed.slice(separator + 1).trim()
  }

  return { values, invalidLines, duplicateLines }
}

const parseNamedCredentialText = (
  raw: string,
  kind: NamedCredentialKind,
  caseInsensitiveNames = false
): ParsedNamedValues =>
  kind === 'environment' ? parseEnvironment(raw, caseInsensitiveNames) : parseHeaders(raw)

export { parseNamedCredentialText }
export type { NamedCredentialKind, ParsedNamedValues }
