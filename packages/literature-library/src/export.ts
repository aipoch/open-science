export const LITERATURE_OVERSIZED_REFERENCE = 'Literature reference exceeds the display budget: '
export function oversizedLiteratureReference(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : ''
  const start = message.indexOf(LITERATURE_OVERSIZED_REFERENCE)
  if (start < 0) return undefined
  const id = message.slice(start + LITERATURE_OVERSIZED_REFERENCE.length).trim()
  return id && id.length <= 512 ? id : undefined
}
