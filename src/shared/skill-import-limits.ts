// Resource caps that bound a skill import from any source (a .zip/.skill bundle or a recursive
// GitHub download). Without them a zip bomb or a very large repository could exhaust memory or freeze
// the app while the user imports a skill from settings. Lives in shared/ so the renderer can enforce
// the same numbers on the upload picker as the main process enforces on extraction/download. The
// limits are generous for a real skill (a SKILL.md plus a handful of reference files) and only trip on
// abuse.
export const SKILL_IMPORT_LIMITS = {
  // Structural cap on the number of files in one import: high enough for a mega-zip carrying several
  // skills, low enough to reject a pathological archive. Total size is the real limit.
  maxFiles: 256,
  // Maximum size of any single file (decompressed, for zip entries).
  maxFileBytes: 5 * 1024 * 1024,
  // Maximum total size across all files in one import (decompressed).
  maxTotalBytes: 10 * 1024 * 1024,
  // Maximum directory nesting either source is allowed to descend (zip subdirectories / GitHub dirs).
  maxDepth: 8,
  // Maximum GitHub API/download requests one import may issue, so a wide or mostly-empty directory
  // tree can't trigger an unbounded number of requests even before any file budget is spent.
  maxRequests: 512
} as const
