import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'

// Re-export the shared caps so main-process modules keep importing them from one place; the renderer
// imports the same constants directly from shared/ to guard the upload picker.
export { SKILL_IMPORT_LIMITS }

// Decodes an uploaded base64 bundle, rejecting an oversized upload from its EXACT decoded length
// before allocating the decoded buffer. base64 encodes 3 bytes per 4 chars, minus 1 byte per `=` pad
// char; whitespace (line-wrapped base64) is ignored. Computing the exact size — not a padding-blind
// estimate — means a payload sitting right on the limit is neither wrongly rejected nor allowed
// through by a couple of bytes.
export const decodeBoundedBase64 = (
  base64: string,
  maxBytes: number = SKILL_IMPORT_LIMITS.maxTotalBytes
): Buffer => {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const decodedBytes = Math.floor(clean.length / 4) * 3 - padding
  if (decodedBytes > maxBytes) {
    throw new Error(`Uploaded bundle exceeds the ${maxBytes}-byte limit.`)
  }
  return Buffer.from(base64, 'base64')
}
