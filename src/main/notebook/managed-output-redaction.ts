const secretPatterns = (values: readonly string[]): string[] =>
  [
    ...new Set(
      values.filter(Boolean).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
    )
  ].sort((a, b) => b.length - a.length)

const redact = (
  text: string,
  secrets: readonly string[],
  withholdPartial: boolean
): { ready: string; pending: string } => {
  if (!secrets.length) return { ready: text, pending: '' }
  let ready = ''
  let offset = 0
  while (offset < text.length) {
    // A complete raw match can also prefix its longer JSON representation. Wait until the
    // next chunk distinguishes them, and scan only input text, never replacement markers.
    if (
      withholdPartial &&
      secrets.some(
        (secret) => secret.length > text.length - offset && secret.startsWith(text.slice(offset))
      )
    )
      break
    const match = secrets.find((secret) => text.startsWith(secret, offset))
    if (match) {
      ready += '[redacted]'
      offset += match.length
    } else {
      ready += text[offset]
      offset++
    }
  }
  return { ready, pending: text.slice(offset) }
}

/** Withhold any suffix that might be the beginning of a secret split across process chunks. */
export const createManagedOutputRedactor = (
  values: readonly string[] = []
): {
  push(text: string): string
  finish(): string
} => {
  const secrets = secretPatterns(values)
  let pending = ''
  return {
    push(text) {
      const result = redact(pending + text, secrets, true)
      pending = result.pending
      return result.ready
    },
    finish() {
      // A partial secret at EOF is withheld too; preserving it has no diagnostic value.
      const ready = pending ? '[redacted]' : ''
      pending = ''
      return ready
    }
  }
}

export const redactManagedOutput = (text: string, values: readonly string[] = []): string =>
  redact(text, secretPatterns(values), false).ready
