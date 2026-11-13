const ARTIFACTS_DIR = 'artifacts'
const PENDING_DIR = '.pending'
const METADATA_DIR = '.metadata'
const CURRENT_RUN_FILE = 'current-run.json'
const RUNS_DIR = '.runs'
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Used for logical lineage and write serialization, never for on-disk metadata keys.
// JavaScript has no native toCaseFold. These additional folds cover sharp-s and final sigma.
const normalizeArtifactFilename = (filename: string): string =>
  filename
    .normalize('NFC')
    .toLocaleLowerCase('und')
    .replace(/\u00df/gu, 'ss')
    .replace(/\u03c2/gu, '\u03c3')

export {
  ARTIFACTS_DIR,
  CURRENT_RUN_FILE,
  METADATA_DIR,
  PENDING_DIR,
  RUNS_DIR,
  SAFE_SEGMENT_PATTERN
}

export { normalizeArtifactFilename }
