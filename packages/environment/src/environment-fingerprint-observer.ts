import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

type FingerprintLanguage = 'python' | 'r'

type FingerprintProbeOutput = {
  language: FingerprintLanguage
  executable: string
  stdout: string
  environment: NodeJS.ProcessEnv
}

type FingerprintObservation = {
  paths: { roots: string[]; watched: string[] }
  signature: string
  fingerprint: string | undefined
  confirmed: boolean
}

const MAX_OBSERVATIONS = 64
// Interpreter search paths read these variables at startup, so a change must re-run the probe.
const SEARCH_PATH_VARIABLES = [
  'PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'R_HOME',
  'R_LIBS',
  'R_LIBS_USER'
]

const probePaths = (stdout: string): FingerprintObservation['paths'] | undefined => {
  const roots: string[] = []
  const watched: string[] = []
  for (const line of stdout.split('\n')) {
    const [kind, path] = line.replace(/\r$/u, '').split('\t')
    if (kind === 'UNWATCHABLE') return undefined
    if (kind === 'ROOT' && path) roots.push(path)
    if (kind === 'WATCH' && path) watched.push(path)
  }
  return roots.length > 0 ? { roots, watched } : undefined
}

const absentErrorCodes = new Set(['ENOENT', 'ENOTDIR'])

const statToken = async (path: string): Promise<string> => {
  try {
    const info = await stat(path, { bigint: true })
    const kind = info.isDirectory() ? 'd' : info.isFile() ? 'f' : 'o'
    return `${kind}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch (error) {
    if (absentErrorCodes.has((error as NodeJS.ErrnoException).code ?? '')) return 'absent'
    throw error
  }
}

// Mirrors the probe scripts: a package is represented by its metadata file when present, so an
// in-place metadata rewrite is noticed even when the library directory itself is unchanged.
const rootTokens = async (language: FingerprintLanguage, root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  const packageTokens = await Promise.all(
    names.map(async (name) => {
      const entry = join(root, name)
      const metadata =
        language === 'r'
          ? join(entry, 'DESCRIPTION')
          : name.endsWith('.dist-info') || name.endsWith('.egg-info')
            ? join(entry, 'METADATA')
            : undefined
      const metadataToken = metadata ? await statToken(metadata) : 'none'
      return `${name}\t${await statToken(entry)}\t${metadataToken}`
    })
  )
  return [`ROOT\t${root}\t${await statToken(root)}`, ...packageTokens]
}

const observationSignature = async (
  output: Omit<FingerprintProbeOutput, 'stdout'>,
  paths: FingerprintObservation['paths']
): Promise<string> => {
  const hash = createHash('sha256')
  hash.update(`${output.language}\n${await statToken(output.executable)}\n`)
  hash.update(JSON.stringify(SEARCH_PATH_VARIABLES.map((name) => output.environment[name] ?? null)))
  for (const watched of paths.watched)
    hash.update(`\nWATCH\t${watched}\t${await statToken(watched)}`)
  for (const root of paths.roots) {
    for (const token of await rootTokens(output.language, root)) hash.update(`\n${token}`)
  }
  return hash.digest('hex')
}

// Reuses an interpreter fingerprint while every path its probe reported is unchanged. The stat
// signature is strictly broader than the probe's own evidence; any stat failure falls back to the
// interpreter probe. A result is reused only after a probe whose surrounding signatures agree, so
// a package change racing with the probe cannot pin a stale fingerprint.
class EnvironmentFingerprintObserver {
  private readonly observations = new Map<string, FingerprintObservation>()

  async capture(
    key: string,
    context: Omit<FingerprintProbeOutput, 'stdout'>,
    probe: () => Promise<string>,
    format: (stdout: string) => string | undefined
  ): Promise<string | undefined> {
    const previous = this.observations.get(key)
    const before = previous
      ? await observationSignature(context, previous.paths).catch(() => undefined)
      : undefined
    if (previous?.confirmed && before === previous.signature) return previous.fingerprint

    this.observations.delete(key)
    const stdout = await probe()
    const fingerprint = format(stdout)
    const paths = probePaths(stdout)
    if (!paths) return fingerprint
    const signature = await observationSignature(context, paths).catch(() => undefined)
    if (!signature) return fingerprint
    this.observations.set(key, {
      paths,
      signature,
      fingerprint,
      confirmed:
        before === signature &&
        previous?.signature === signature &&
        previous.fingerprint === fingerprint
    })
    if (this.observations.size > MAX_OBSERVATIONS) {
      this.observations.delete(this.observations.keys().next().value!)
    }
    return fingerprint
  }

  forget(key: string): void {
    this.observations.delete(key)
  }
}

export { EnvironmentFingerprintObserver }
