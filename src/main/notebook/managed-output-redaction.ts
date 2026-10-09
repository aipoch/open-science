/** Withhold any suffix that might be the beginning of a secret split across process chunks. */
export const createManagedOutputRedactor = (
  values: readonly string[] = []
): {
  push(text: string): string
  finish(): string
} => {
  const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length)
  let pending = ''
  const replace = (text: string): string => {
    for (const secret of secrets) text = text.split(secret).join('[redacted]')
    return text
  }
  return {
    push(text) {
      pending += text
      // Replace complete secrets before calculating the suffix: holding back a suffix of a
      // complete match could otherwise leak its prefix on this call.
      pending = replace(pending)
      let hold = 0
      for (const secret of secrets) {
        for (let length = Math.min(secret.length - 1, pending.length); length > hold; length--) {
          if (pending.endsWith(secret.slice(0, length))) {
            hold = length
            break
          }
        }
      }
      const ready = pending.slice(0, pending.length - hold)
      pending = pending.slice(pending.length - hold)
      return ready
    },
    finish() {
      // A partial secret at EOF is withheld too; preserving it has no diagnostic value.
      const ready = pending ? '[redacted]' : ''
      pending = ''
      return ready
    }
  }
}

export const redactManagedOutput = (text: string, values: readonly string[] = []): string => {
  for (const secret of [...values].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[redacted]')
  return text
}
