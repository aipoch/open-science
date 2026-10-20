import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const MARKER_FILE = '.open-science-notebook-cache.json'
const MARKER_KIND = 'notebook-workload-cache'

type WorkloadCacheMarker = {
  schema?: number
  kind?: string
  canonicalRoot?: string
}

const pathKey = (path: string, platform: NodeJS.Platform = process.platform): string => {
  const normalized = resolve(path)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

const expectedMarker = (cacheRoot: string): Required<WorkloadCacheMarker> => ({
  schema: 1,
  kind: MARKER_KIND,
  canonicalRoot: realpathSync.native(cacheRoot)
})

const markerMatches = (
  marker: WorkloadCacheMarker,
  expected: Required<WorkloadCacheMarker>,
  platform: NodeJS.Platform = process.platform
): boolean =>
  marker.schema === expected.schema &&
  marker.kind === expected.kind &&
  typeof marker.canonicalRoot === 'string' &&
  pathKey(marker.canonicalRoot, platform) === pathKey(expected.canonicalRoot, platform)

const isExpectedPhysicalChild = (parent: string, child: string, name: string): boolean =>
  pathKey(realpathSync.native(child)) === pathKey(join(realpathSync.native(parent), name))

export const notebookWorkloadCacheRoot = (runtimeRoot: string): string =>
  join(runtimeRoot, 'cache', 'notebook')

export const notebookWorkloadCacheEnv = (runtimeRoot: string): NodeJS.ProcessEnv => {
  const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)
  return {
    OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
    MPLCONFIGDIR: join(cacheRoot, 'matplotlib'),
    PIP_CACHE_DIR: join(cacheRoot, 'pip'),
    UV_CACHE_DIR: join(cacheRoot, 'uv'),
    HF_HUB_CACHE: join(cacheRoot, 'huggingface', 'hub'),
    HF_DATASETS_CACHE: join(cacheRoot, 'huggingface', 'datasets'),
    HF_XET_CACHE: join(cacheRoot, 'huggingface', 'xet'),
    HF_ASSETS_CACHE: join(cacheRoot, 'huggingface', 'assets'),
    TORCH_HOME: join(cacheRoot, 'torch'),
    TORCHINDUCTOR_CACHE_DIR: join(cacheRoot, 'torch', 'inductor'),
    TORCH_EXTENSIONS_DIR: join(cacheRoot, 'torch', 'extensions'),
    PYTORCH_KERNEL_CACHE_PATH: join(cacheRoot, 'torch', 'kernels'),
    TRITON_CACHE_DIR: join(cacheRoot, 'torch', 'triton'),
    NUMBA_CACHE_DIR: join(cacheRoot, 'numba'),
    R_USER_CACHE_DIR: join(cacheRoot, 'r')
  }
}

export const prepareNotebookWorkloadCache = (runtimeRoot: string): NodeJS.ProcessEnv => {
  if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
    throw new Error('Notebook workload cache requires an absolute runtime root.')
  }
  const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)
  const cacheParent = dirname(cacheRoot)
  let created = false

  try {
    // Validate the parent before creating the removable subtree. A linked runtime/cache directory could
    // otherwise redirect both cache writes and the later recursive cleanup outside the data root.
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
    try {
      const parentState = lstatSync(cacheParent)
      if (!parentState.isDirectory() || parentState.isSymbolicLink()) {
        throw new Error('Notebook workload cache parent is not a trusted directory.')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(cacheParent, { mode: 0o700 })
    }
    if (!isExpectedPhysicalChild(runtimeRoot, cacheParent, 'cache')) {
      throw new Error('Notebook workload cache parent resolves to an unexpected physical path.')
    }

    let state
    try {
      state = lstatSync(cacheRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(cacheRoot, { mode: 0o700 })
      created = true
      state = lstatSync(cacheRoot)
    }

    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error('Notebook workload cache path is not a trusted directory.')
    }
    if (!isExpectedPhysicalChild(cacheParent, cacheRoot, 'notebook')) {
      throw new Error('Notebook workload cache resolves to an unexpected physical path.')
    }
    const marker = expectedMarker(cacheRoot)

    // Keep ownership authority in the protected parent, outside the subtree exposed to kernels and
    // shells. Deleting the disposable cache root then leaves enough authority for the main process to
    // recreate it safely on the next operation.
    const markerPath = join(cacheParent, MARKER_FILE)
    let existing: WorkloadCacheMarker | undefined
    try {
      existing = JSON.parse(readFileSync(markerPath, 'utf8')) as WorkloadCacheMarker
    } catch (error) {
      if (!created || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Notebook workload cache ownership marker is missing or unreadable.')
      }
      writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
    }
    if (existing && !markerMatches(existing, marker)) {
      throw new Error('Notebook workload cache ownership marker does not match this location.')
    }
  } catch (error) {
    if (created) {
      try {
        rmSync(cacheRoot, { recursive: true, force: true })
      } catch {
        // Preserve the preparation failure; later startup can inspect any residue.
      }
    }
    throw error
  }

  return notebookWorkloadCacheEnv(runtimeRoot)
}

export const removeNotebookWorkloadCache = (runtimeRoot: string): boolean => {
  const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)
  const cacheParent = dirname(cacheRoot)
  try {
    let parentState: ReturnType<typeof lstatSync>
    try {
      parentState = lstatSync(cacheParent)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    if (!parentState.isDirectory() || parentState.isSymbolicLink()) return false
    if (!isExpectedPhysicalChild(runtimeRoot, cacheParent, 'cache')) return false
    const markerPath = join(cacheParent, MARKER_FILE)
    let state: ReturnType<typeof lstatSync>
    try {
      state = lstatSync(cacheRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      try {
        const existing = JSON.parse(readFileSync(markerPath, 'utf8')) as WorkloadCacheMarker
        if (
          !markerMatches(existing, {
            schema: 1,
            kind: MARKER_KIND,
            canonicalRoot: join(realpathSync.native(cacheParent), 'notebook')
          })
        )
          return false
        rmSync(markerPath, { force: true })
        return true
      } catch (markerError) {
        return (markerError as NodeJS.ErrnoException).code === 'ENOENT'
      }
    }
    if (!state.isDirectory() || state.isSymbolicLink()) return false
    if (!isExpectedPhysicalChild(cacheParent, cacheRoot, 'notebook')) return false
    const marker = expectedMarker(cacheRoot)
    const existing = JSON.parse(readFileSync(markerPath, 'utf8')) as WorkloadCacheMarker
    if (!markerMatches(existing, marker)) return false
    rmSync(cacheRoot, { recursive: true, force: true })
    rmSync(markerPath, { force: true })
    return true
  } catch {
    return false
  }
}
