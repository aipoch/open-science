import { createLogger, diagnosticErrorFields } from '../logger'
import { withExclusiveCacheLocks } from './pkgs-cache-lock'

const logger = createLogger('notebook:package-cache')

// `clean` does not accept --root-prefix. Callers bind MAMBA_ROOT_PREFIX and CONDA_PKGS_DIRS in the
// subprocess environment so cleanup cannot follow inherited host Conda settings outside app storage.
export const packageCacheCleanArgv = (micromamba: string): string[] => [
  micromamba,
  '--no-rc',
  'clean',
  '--packages',
  '--tarballs',
  '--yes'
]

// Cache maintenance is opportunistic: a cleanup bug must not turn a package/environment mutation that
// could otherwise succeed into a new hard failure. The existing exclusive cache locks still make the
// deletion safe with respect to concurrent create/install operations.
export const maintainPackageCacheBestEffort = async (
  cacheLockKeys: string[],
  run: () => Promise<void>
): Promise<void> => {
  try {
    await withExclusiveCacheLocks(cacheLockKeys, run)
  } catch (error) {
    logger.warn('package cache maintenance failed', diagnosticErrorFields(error))
  }
}
