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

/** stdout and stderr are handled separately by the download step. */
const SEPARATELY_HANDLED = new Set(['stdout', 'stderr'])

const DEFAULT_MAX_FILE_MB = 100
const DEFAULT_MAX_TOTAL_MB = 500

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
 * 3. stdout/stderr are handled separately (excluded from general classification).
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
  const maxFileMb = config.max_file_mb ?? DEFAULT_MAX_FILE_MB
  const maxTotalMb = config.max_total_mb ?? DEFAULT_MAX_TOTAL_MB
  const excludeGlobs = config.exclude ?? []

  const featured: string[] = []
  const hidden: string[] = []
  const remote: string[] = []
  const excluded: string[] = []
  const left_on_remote: LeftOnRemoteEntry[] = []

  // Accumulated downloaded size in MB (for cumulative threshold check).
  let totalMb = 0
  // Whether the cumulative threshold has been breached (all subsequent files go to remote).
  let totalExceeded = false

  for (const entry of files) {
    const { path, size_bytes } = entry
    const size_mb = size_bytes / (1024 * 1024)

    // Rule 1: control files always excluded.
    if (CONTROL_FILES.has(path)) {
      excluded.push(path)
      continue
    }

    // Rule 2: staged inputs always excluded.
    if (stagedInputs.has(path)) {
      excluded.push(path)
      continue
    }

    // Rule 3: stdout/stderr handled separately — skip general classification.
    if (SEPARATELY_HANDLED.has(path)) {
      continue
    }

    // Rule 4: harvest.exclude globs.
    if (excludeGlobs.length > 0 && micromatch.isMatch(path, excludeGlobs)) {
      excluded.push(path)
      continue
    }

    // Determine disposition from output declarations.
    let disposition: 'featured' | 'hidden' | 'remote' | 'unmatched' = 'unmatched'

    if (outputs.length === 0) {
      // Rule 6: no outputs declaration — default hidden.
      disposition = 'hidden'
    } else {
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
    } else {
      hidden.push(path)
    }
  }

  const to_download = [...featured, ...hidden]

  return { featured, hidden, remote, excluded, left_on_remote, to_download }
}
