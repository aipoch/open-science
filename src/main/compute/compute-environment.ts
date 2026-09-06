const COMPUTE_ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

const COMPUTE_ENVIRONMENT_ROOT = '~/.openscience/environments'

const computeEnvironmentPath = (name: string): string => {
  validateComputeEnvironmentName(name)
  return `${COMPUTE_ENVIRONMENT_ROOT}/${name}.sh`
}

const validateComputeEnvironmentName = (name: string): void => {
  if (!COMPUTE_ENVIRONMENT_NAME.test(name)) {
    throw new Error(
      'Compute environment must be 1-64 characters, start with a letter or number, and contain only letters, numbers, periods, underscores, or hyphens.'
    )
  }
}

// Keep a leading shell/scheduler header at the top of the job script. Slurm, PBS, and LSF only
// interpret directives before the first executable line; inserting activation ahead of them would
// silently turn resource requests into comments.
const environmentInsertionIndex = (lines: string[]): number => {
  let index = 0
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) break
    index += 1
  }
  return index
}

const computeEnvironmentPreamble = (name: string): string[] => {
  const path = computeEnvironmentPath(name)
  return [
    `OPEN_SCIENCE_ENV_FILE="$HOME/.openscience/environments/${name}.sh"`,
    'if [ ! -r "$OPEN_SCIENCE_ENV_FILE" ]; then',
    `  printf '%s\n' 'Compute environment "${name}" is not configured at ${path}. Load the compute-env-setup Skill (bundled as os-compute-env-setup) to prepare setup instructions and validate a user-managed activation.' >&2`,
    '  exit 78',
    'fi',
    // Source as a plain command under errexit so every activation command fails fast. Putting the
    // source on the left side of `||` would disable errexit inside the sourced file in Bash. Restore
    // the caller's prior setting afterward so selecting an environment does not change workload
    // shell semantics.
    'case $- in *e*) OPEN_SCIENCE_ENV_HAD_ERREXIT=1 ;; *) OPEN_SCIENCE_ENV_HAD_ERREXIT=0 ;; esac',
    'set -e',
    '. "$OPEN_SCIENCE_ENV_FILE"',
    'if [ "$OPEN_SCIENCE_ENV_HAD_ERREXIT" = 1 ]; then set -e; else set +e; fi',
    'unset OPEN_SCIENCE_ENV_HAD_ERREXIT',
    'unset OPEN_SCIENCE_ENV_FILE'
  ]
}

const applyComputeEnvironment = (command: string, environment: string | undefined): string => {
  if (environment === undefined) return command
  const lines = command.split('\n')
  const index = environmentInsertionIndex(lines)
  lines.splice(index, 0, ...computeEnvironmentPreamble(environment))
  return lines.join('\n')
}

export {
  COMPUTE_ENVIRONMENT_ROOT,
  applyComputeEnvironment,
  computeEnvironmentPath,
  validateComputeEnvironmentName
}
