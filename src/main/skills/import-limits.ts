import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'

// Re-export the shared caps so main-process modules keep importing them from one place; the renderer
// imports the same constants directly from shared/ to guard the upload picker.
export { SKILL_IMPORT_LIMITS }

// Matches a well-formed base64 body: alphabet chars followed by at most two `=` pad chars, and
// nothing else. This enforces that padding appears only at the end (not mid-string) and that no
// stray non-base64 characters are present.
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/

// Decodes an uploaded base64 bundle, rejecting an oversized upload from its EXACT decoded length
// before allocating the decoded buffer. Only whitespace (line-wrapped base64) is stripped — any other
// character makes the input invalid rather than being silently dropped. The decoded size is
// floor(chars * 3 / 4) minus one byte per `=` pad char: using chars*3/4 rather than floor(chars/4)*3
// accounts for the final partial group, so an UNPADDED payload whose length isn't a multiple of 4
// can't under-count its way past the cap (e.g. 11 unpadded bytes under a 10-byte cap).
export const decodeBoundedBase64 = (
  base64: string,
  maxBytes: number = SKILL_IMPORT_LIMITS.maxTotalBytes
): Buffer => {
  const clean = base64.replace(/\s+/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  // Reject stray characters / misplaced padding, a lone trailing char (encodes no byte), and padded
  // input that isn't a whole number of 4-char groups.
  if (
    !BASE64_BODY.test(clean) ||
    clean.length % 4 === 1 ||
    (padding > 0 && clean.length % 4 !== 0)
  ) {
    throw new Error('Uploaded bundle is not valid base64.')
  }
  const decodedBytes = Math.floor((clean.length * 3) / 4) - padding
  if (decodedBytes > maxBytes) {
    throw new Error(`Uploaded bundle exceeds the ${maxBytes}-byte limit.`)
  }
  return Buffer.from(clean, 'base64')
}
