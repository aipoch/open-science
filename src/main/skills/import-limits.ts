// Resource caps that bound a skill import from any source (a .zip/.skill bundle or a recursive
// GitHub download). Without them a zip bomb or a very large repository could exhaust memory or
// freeze the app while the user imports a skill from settings. The limits are generous for a real
// skill (a SKILL.md plus a handful of reference scripts/docs) and only ever trip on abuse.
export const SKILL_IMPORT_LIMITS = {
  // Maximum number of files materialized from one import.
  maxFiles: 2000,
  // Maximum size of any single file (decompressed, for zip entries).
  maxFileBytes: 16 * 1024 * 1024,
  // Maximum total size across all files in one import (decompressed).
  maxTotalBytes: 64 * 1024 * 1024,
  // Maximum directory nesting a recursive source (GitHub) is allowed to descend.
  maxDepth: 24
} as const
