// Resource caps that bound a skill import from any source (a .zip/.skill bundle or a recursive
// GitHub download). Without them a zip bomb or a very large repository could exhaust memory or freeze
// the app while the user imports a skill from settings. Lives in shared/ so the renderer can enforce
// the same numbers on the upload picker as the main process enforces on extraction/download. The
// limits are generous for a real skill (a SKILL.md plus a handful of reference files) and only trip on
// abuse.
export const SKILL_IMPORT_LIMITS = {
  // Structural cap on the number of files in ONE skill: high enough for a mega-zip carrying several
  // skills, low enough to reject a pathological archive. Total size is the real limit.
  maxFiles: 256,
  // Maximum size of any single file (decompressed, for zip entries). Set high because real skills
  // legitimately bundle large reference assets (datasets, templates, model files) worth keeping.
  maxFileBytes: 50 * 1024 * 1024,
  // Maximum total decompressed size of ONE skill (all files in a single skill root / inner bundle).
  // Comfortably above the single-file cap so a skill can carry a large file plus its other resources.
  maxTotalBytes: 128 * 1024 * 1024,
  // Maximum directory nesting either source is allowed to descend (zip subdirectories / GitHub dirs).
  maxDepth: 8,
  // Maximum GitHub API/download requests one import may issue, so a wide or mostly-empty directory
  // tree can't trigger an unbounded number of requests even before any file budget is spent.
  maxRequests: 512,
  // --- Multi-skill / nested-bundle caps ---------------------------------------------------------
  // A single uploaded bundle may hold many skills, each as a nested .zip/.skill entry. These caps
  // bound the OUTER bundle so a resilient (skip-the-bad, keep-the-good) import can't be turned into a
  // memory bomb: the per-skill caps above still apply to each individual skill once it's unpacked.
  //
  // Largest nested skill archive we'll even attempt to unpack (compressed). An inner archive bigger
  // than this is skipped as "too large" rather than decompressed, so one oversized skill never blocks
  // the rest of the bundle. Sized so a skill archive carrying a large reference asset still unpacks.
  maxSkillArchiveBytes: 64 * 1024 * 1024,
  // Largest uploaded bundle overall (the outer .zip). Generous enough for a bundle of several sizeable
  // skills, bounded so a single upload can't exhaust memory. NOTE: the decoded bundle plus its
  // extracted entries are held in memory during import, so this is the dominant memory bound.
  maxBundleBytes: 256 * 1024 * 1024,
  // Most skills one bundle may contribute, so a pathological archive of tiny skills can't produce an
  // unbounded number of import candidates.
  maxSkillsPerBundle: 256,
  // Structural cap on the number of entries in the OUTER bundle walk (loose files + nested archives),
  // above the per-skill file cap since one bundle may hold many skills. Decompressed size
  // (maxBundleBytes) is the real memory guard; this only rejects an archive with a pathological entry
  // count.
  maxBundleEntries: 4096
} as const
