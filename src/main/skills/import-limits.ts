import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'

// Re-export the shared caps so main-process modules keep importing them from one place; the renderer
// imports the same constants directly from shared/ to guard the upload picker.
export { SKILL_IMPORT_LIMITS }

// Decodes an uploaded base64 bundle, rejecting an oversized upload from its EXACT decoded length
// before allocating the decoded buffer. Whitespace (line-wrapped base64) is ignored. The decoded
// size is floor(chars * 3 / 4) minus one byte per `=` pad char: using chars*3/4 rather than
// floor(chars/4)*3 accounts for the final partial group, so an UNPADDED payload whose length isn't a
// multiple of 4 can't under-count its way past the cap (e.g. 11 unpadded bytes under a 10-byte cap).
export const decodeBoundedBase64 = (
  base64: string,
  maxBytes: number = SKILL_IMPORT_LIMITS.maxTotalBytes
): Buffer => {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '')
  // A group of a single base64 char encodes no bytes and is never valid.
  if (clean.length % 4 === 1) {
    throw new Error('Uploaded bundle is not valid base64.')
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const decodedBytes = Math.floor((clean.length * 3) / 4) - padding
  if (decodedBytes > maxBytes) {
    throw new Error(`Uploaded bundle exceeds the ${maxBytes}-byte limit.`)
  }
  return Buffer.from(base64, 'base64')
}
