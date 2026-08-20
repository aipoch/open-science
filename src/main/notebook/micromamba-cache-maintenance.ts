import { createLogger, diagnosticErrorFields } from '../logger'
import { withExclusiveCacheLocks } from './pkgs-cache-lock'
import { isChildUnconfirmedError } from './provisioner-runtime'

const logger = createLogger('notebook:package-cache')

// `clean` does not accept --root-prefix. Callers bind MAMBA_ROOT_PREFIX and CONDA_PKGS_DIRS in the
// subprocess environment so cleanup cannot follow inherited host Conda settings outside app storage.
export const packageCacheCleanArgv = (micromamba: string): string[] => [
  micromamba,
  '--no-rc',
  'clean',
  '--packages',
  '--yes'
]

// Cache maintenance is opportunistic for ordinary failures: a cleanup bug must not turn a package or
// environment mutation that could otherwise succeed into a new hard failure. CHILD_UNCONFIRMED is the
// exception: the cleanup worker may still be deleting cache entries, so the journaled caller must retain
// its recovery evidence and refuse to start another cache writer.
export const maintainPackageCacheBestEffort = async (
  cacheLockKeys: string[],
  run: () => Promise<void>
): Promise<void> => {
  try {
    await withExclusiveCacheLocks(cacheLockKeys, run)
  } catch (error) {
    if (isChildUnconfirmedError(error)) throw error
    logger.warn('package cache maintenance failed', diagnosticErrorFields(error))
  }
}
