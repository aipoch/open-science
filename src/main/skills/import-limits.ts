// Resource caps that bound a skill import from any source (a .zip/.skill bundle or a recursive
// GitHub download). Without them a zip bomb or a very large repository could exhaust memory or
// freeze the app while the user imports a skill from settings. The limits are generous for a real
// skill (a SKILL.md plus a handful of reference scripts/docs) and only ever trip on abuse.
export const SKILL_IMPORT_LIMITS = {
  // Structural cap on the number of files in one import: high enough for a mega-zip carrying several
  // skills, low enough to reject a pathological archive. Total size is the real limit.
  maxFiles: 256,
  // Maximum size of any single file (decompressed, for zip entries).
  maxFileBytes: 5 * 1024 * 1024,
  // Maximum total size across all files in one import (decompressed).
  maxTotalBytes: 10 * 1024 * 1024,
  // Maximum directory nesting either source is allowed to descend (zip path segments / GitHub dirs).
  maxDepth: 8,
  // Maximum GitHub API/download requests one import may issue, so a wide or mostly-empty directory
  // tree can't trigger an unbounded number of requests even before any file budget is spent.
  maxRequests: 512
} as const

// Decodes an uploaded base64 bundle, rejecting an oversized upload from its encoded length BEFORE
// allocating the decoded buffer. Four base64 chars encode three bytes, so the decoded size is
// estimated up front; a bundle over the cap never gets decoded into memory.
export const decodeBoundedBase64 = (
  base64: string,
  maxBytes: number = SKILL_IMPORT_LIMITS.maxTotalBytes
): Buffer => {
  const approxBytes = Math.floor(base64.length / 4) * 3
  if (approxBytes > maxBytes) {
    throw new Error(`Uploaded bundle exceeds the ${maxBytes}-byte limit.`)
  }
  return Buffer.from(base64, 'base64')
}
