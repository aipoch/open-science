export const isSafeUrl = (value: string): boolean => {
  const trimmed = value.trim()
  if (!trimmed || /\s/u.test(trimmed)) return false
  try {
    const url = new URL(trimmed, globalThis.location?.href ?? 'http://localhost/')
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}
