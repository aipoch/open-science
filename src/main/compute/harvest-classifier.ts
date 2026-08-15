/**
 * harvest-classifier.ts — pure classification logic for harvest output files.
 *
 * No SSH, no fs, no network dependencies. Given a remote file listing,
 * output declarations, and harvest config, determines the disposition of
 * every file without performing any I/O.
 *
 * See design.md §5 and §6 for the classification rules this module implements.
 */

// micromatch is a transitive dep already present in node_modules (verified via ls).
import micromatch from 'micromatch'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single file entry from the remote workdir listing (path is relative to workdir). */
export type FileEntry = {
  path: string
  size_bytes: number
}

/**
 * Output declaration from submit_job's `outputs` parameter.
 * A bare string is a shorthand for { glob, visibility: 'featured' }.
 */
export type OutputDeclaration =
  string | { glob: string; visibility?: 'featured' | 'hidden'; residency?: 'remote' }

/** harvest config from the ComputeJob.harvestConfig JSON column. */
export type HarvestConfig = {
  exclude?: string[]
  max_file_mb?: number
  max_total_mb?: number
}

/** A file that was left on the remote side (not downloaded). */
export type LeftOnRemoteEntry = {
  path: string
  size_mb: number
  reason: 'residency_remote' | 'exceeds_max_file_mb' | 'exceeds_max_total_mb'
}

/** Classification result for a full file listing. */
export type ClassifyResult = {
  /** Files to download into featured/ subdirectory. */
  featured: string[]
  /** Files to download into hidden/ subdirectory. */
  hidden: string[]
  /** Full stdout/stderr files to download into the harvest root. */
  logs: string[]
  /** Files declared residency:remote — recorded but not downloaded. */
  remote: string[]
  /** Files excluded by control-file rules, staged-input rules, or harvest.exclude. */
  excluded: string[]
  /** All files that will not be downloaded, with size and reason. */
  left_on_remote: LeftOnRemoteEntry[]
  /** Ordered list of files to pass to the download step (featured + hidden, thresholded). */
  to_download: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Control files always excluded — never downloaded regardless of outputs declarations. */
const CONTROL_FILES = new Set(['command.sh', 'launcher.sh', 'exit_code', 'job.pid'])

/** stdout and stderr share the download budget but are scheduled after declared outputs. */
const LOG_FILES = new Set(['stdout', 'stderr'])

export const HARVEST_MAX_FILE_MB = 100
export const HARVEST_MAX_TOTAL_MB = 500

const normalizedLimit = (value: unknown, maximum: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, value))
    : maximum

/** Defensively constrains persisted limits without rewriting historical rows. */
export const normalizeHarvestConfig = (config: unknown): HarvestConfig => {
  const candidate =
    typeof config === 'object' && config !== null && !Array.isArray(config)
      ? (config as HarvestConfig)
      : {}
  return {
    ...candidate,
    exclude: Array.isArray(candidate.exclude)
      ? candidate.exclude.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    max_file_mb: normalizedLimit(candidate.max_file_mb, HARVEST_MAX_FILE_MB),
    max_total_mb: normalizedLimit(candidate.max_total_mb, HARVEST_MAX_TOTAL_MB)
  }
}

const assertLimit = (field: string, value: unknown, maximum: number): void => {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${field} must be a finite number between 0 and ${maximum} MiB.`)
  }
}

/** Rejects model-provided limits that would weaken the application-owned safety boundary. */
export function validateHarvestConfig(config: unknown): asserts config is HarvestConfig {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('harvest must be an object.')
  }
  const candidate = config as Record<string, unknown>
  assertLimit('harvest.max_file_mb', candidate.max_file_mb, HARVEST_MAX_FILE_MB)
  assertLimit('harvest.max_total_mb', candidate.max_total_mb, HARVEST_MAX_TOTAL_MB)
}

// ---------------------------------------------------------------------------
// classifyFiles
// ---------------------------------------------------------------------------

/**
 * Classifies every file in the remote file listing according to the output
 * declarations, harvest config, and staged input set.
 *
 * Rules (in priority order):
 * 1. Control files are always excluded.
 * 2. Staged input bare names are always excluded.
 * 3. Declared outputs are considered before stdout/stderr so logs cannot crowd them out.
 * 4. harvest.exclude glob matches are excluded.
 * 5. If outputs is non-empty, match each file against the output declarations.
 * 6. If outputs is empty, classify as hidden (default "collect everything").
 * 7. Files with no matching output declaration and non-empty outputs are not downloaded.
 * 8. Apply max_file_mb per-file threshold.
 * 9. Apply max_total_mb cumulative threshold (in-order).
 *
 * @param files - Remote file listing, path relative to workdir, with size in bytes.
 * @param outputs - Output declarations from submit_job (may be empty).
 * @param config - Harvest configuration (thresholds, exclusions).
 * @param stagedInputs - Set of bare filenames from inputManifest that were staged as inputs.
 */
export const classifyFiles = (
  files: FileEntry[],
  outputs: OutputDeclaration[],
  config: HarvestConfig,
  stagedInputs: ReadonlySet<string>
): ClassifyResult => {
  const normalizedConfig = normalizeHarvestConfig(config)
  const maxFileMb = normalizedConfig.max_file_mb ?? HARVEST_MAX_FILE_MB
  const maxTotalMb = normalizedConfig.max_total_mb ?? HARVEST_MAX_TOTAL_MB
  const excludeGlobs = normalizedConfig.exclude ?? []

  const featured: string[] = []
  const hidden: string[] = []
  const remote: string[] = []
  const excluded: string[] = []
  const left_on_remote: LeftOnRemoteEntry[] = []

  const logs: string[] = []
  // Accumulated downloaded size in MB (for cumulative threshold check).
  let totalMb = 0
  // Whether the cumulative threshold has been breached (all subsequent files go to remote).
  let totalExceeded = false

  const orderedFiles = [
    ...files.filter((entry) => !LOG_FILES.has(entry.path)),
    ...files.filter((entry) => LOG_FILES.has(entry.path))
  ]

  for (const entry of orderedFiles) {
    const { path, size_bytes } = entry
    const size_mb = size_bytes / (1024 * 1024)

    // Rule 1: control files always excluded.
    if (CONTROL_FILES.has(path)) {
      excluded.push(path)
      continue
    }
    const isLog = LOG_FILES.has(path)

    // Rule 2: staged inputs always excluded.
    if (stagedInputs.has(path)) {
      excluded.push(path)
      continue
    }

    // Rule 4: harvest.exclude globs.
    if (!isLog && excludeGlobs.length > 0 && micromatch.isMatch(path, excludeGlobs)) {
      excluded.push(path)
      continue
    }

    // Determine disposition from output declarations.
    let disposition: 'featured' | 'hidden' | 'log' | 'remote' | 'unmatched' = isLog
      ? 'log'
      : 'unmatched'

    if (!isLog && outputs.length === 0) {
      // Rule 6: no outputs declaration — default hidden.
      disposition = 'hidden'
    } else if (!isLog) {
      // Rule 5: match against output declarations in order; first match wins.
      for (const decl of outputs) {
        if (typeof decl === 'string') {
          // Bare string = { glob, visibility: 'featured' }
          if (micromatch.isMatch(path, decl)) {
            disposition = 'featured'
            break
          }
        } else {
          if (micromatch.isMatch(path, decl.glob)) {
            if (decl.residency === 'remote') {
              disposition = 'remote'
            } else {
              // Default visibility is 'featured' when residency is not 'remote'.
              disposition = (decl.visibility ?? 'featured') as 'featured' | 'hidden'
            }
            break
          }
        }
      }
    }

    // Unmatched files with non-empty outputs declarations are not downloaded.
    // (They remain on remote but are not explicitly tracked in left_on_remote unless they
    // are captured by the residency:remote path.)
    if (disposition === 'unmatched') {
      continue
    }

    // Rule: residency:remote files are recorded but never downloaded.
    if (disposition === 'remote') {
      remote.push(path)
      left_on_remote.push({ path, size_mb, reason: 'residency_remote' })
      continue
    }

    // Rules 8 & 9: size threshold checks for files that would be downloaded.
    if (size_mb > maxFileMb) {
      left_on_remote.push({ path, size_mb, reason: 'exceeds_max_file_mb' })
      continue
    }

    if (totalExceeded || totalMb + size_mb > maxTotalMb) {
      totalExceeded = true
      left_on_remote.push({ path, size_mb, reason: 'exceeds_max_total_mb' })
      continue
    }

    // File passes all checks — add to the appropriate category and accumulate size.
    totalMb += size_mb

    if (disposition === 'featured') {
      featured.push(path)
    } else if (disposition === 'log') {
      logs.push(path)
    } else {
      hidden.push(path)
    }
  }

  const to_download = [...featured, ...hidden, ...logs]

  return { featured, hidden, logs, remote, excluded, left_on_remote, to_download }
}
