// Allows Electron to hand off only normal web URLs; malformed and privileged schemes fail closed.
export const isAllowedExternalUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
