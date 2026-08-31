import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  notebookWorkloadCacheRoot,
  prepareNotebookWorkloadCache,
  removeNotebookWorkloadCache
} from './notebook-workload-cache-paths'

const roots: string[] = []
const makeRuntime = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'open-science-workload-cache-'))
  roots.push(root)
  return join(root, '数据', 'OpenScience', 'runtime')
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('NotebookWorkloadCache', () => {
  it('prepares one marker-owned Unicode cache root and cache-only environment projection', () => {
    const runtimeRoot = makeRuntime()
    const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)

    const env = prepareNotebookWorkloadCache(runtimeRoot)

    expect(env).toEqual({
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
    })
    expect(
      JSON.parse(
        readFileSync(join(runtimeRoot, 'cache', '.open-science-notebook-cache.json'), 'utf8')
      )
    ).toEqual({
      schema: 1,
      kind: 'notebook-workload-cache',
      canonicalRoot: realpathSync.native(cacheRoot)
    })
    expect(existsSync(join(cacheRoot, '.open-science-notebook-cache.json'))).toBe(false)
    expect(existsSync(join(cacheRoot, 'pip'))).toBe(false)
  })

  it('recreates a user-deleted cache subtree from its protected sibling marker', () => {
    const runtimeRoot = makeRuntime()
    const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)
    prepareNotebookWorkloadCache(runtimeRoot)

    rmSync(cacheRoot, { recursive: true, force: true })

    expect(() => prepareNotebookWorkloadCache(runtimeRoot)).not.toThrow()
    expect(existsSync(cacheRoot)).toBe(true)
  })

  it('removes only a matching marker-owned cache subtree', () => {
    const runtimeRoot = makeRuntime()
    const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)
    prepareNotebookWorkloadCache(runtimeRoot)
    const sibling = join(runtimeRoot, 'keep.txt')
    writeFileSync(sibling, 'keep')

    expect(removeNotebookWorkloadCache(runtimeRoot)).toBe(true)

    expect(existsSync(cacheRoot)).toBe(false)
    expect(readFileSync(sibling, 'utf8')).toBe('keep')
  })

  it('treats an absent cache as already removed', () => {
    const runtimeRoot = makeRuntime()

    expect(removeNotebookWorkloadCache(runtimeRoot)).toBe(true)
  })

  it('removes a matching orphaned sibling marker when the cache subtree is absent', () => {
    const runtimeRoot = makeRuntime()
    const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)
    const cacheParent = join(runtimeRoot, 'cache')
    const markerPath = join(cacheParent, '.open-science-notebook-cache.json')
    prepareNotebookWorkloadCache(runtimeRoot)
    rmSync(cacheRoot, { recursive: true })

    expect(removeNotebookWorkloadCache(runtimeRoot)).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('accepts a runtime reached through a trusted ancestor alias', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'open-science-workload-cache-alias-'))
    roots.push(sandbox)
    const physicalRoot = join(sandbox, 'physical')
    const aliasRoot = join(sandbox, 'alias')
    mkdirSync(physicalRoot)
    symlinkSync(physicalRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const runtimeRoot = join(aliasRoot, 'runtime')
    const physicalRuntimeRoot = join(physicalRoot, 'runtime')

    expect(() => prepareNotebookWorkloadCache(runtimeRoot)).not.toThrow()
    expect(existsSync(notebookWorkloadCacheRoot(runtimeRoot))).toBe(true)
    expect(() => prepareNotebookWorkloadCache(physicalRuntimeRoot)).not.toThrow()
    expect(removeNotebookWorkloadCache(physicalRuntimeRoot)).toBe(true)
  })

  it('refuses a pre-existing unmarked or mismatched directory', () => {
    const runtimeRoot = makeRuntime()
    const cacheRoot = notebookWorkloadCacheRoot(runtimeRoot)
    mkdirSync(cacheRoot, { recursive: true })
    writeFileSync(join(cacheRoot, 'foreign.txt'), 'keep')

    expect(() => prepareNotebookWorkloadCache(runtimeRoot)).toThrow(/ownership marker/i)
    expect(removeNotebookWorkloadCache(runtimeRoot)).toBe(false)
    expect(readFileSync(join(cacheRoot, 'foreign.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a linked cache parent without writing to or deleting its target', () => {
    const runtimeRoot = makeRuntime()
    const linkedTarget = mkdtempSync(join(tmpdir(), 'open-science-foreign-cache-'))
    roots.push(linkedTarget)
    mkdirSync(runtimeRoot, { recursive: true })
    symlinkSync(
      linkedTarget,
      join(runtimeRoot, 'cache'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    writeFileSync(join(linkedTarget, 'foreign.txt'), 'keep')

    expect(() => prepareNotebookWorkloadCache(runtimeRoot)).toThrow(/parent.*trusted directory/i)
    expect(removeNotebookWorkloadCache(runtimeRoot)).toBe(false)
    expect(readFileSync(join(linkedTarget, 'foreign.txt'), 'utf8')).toBe('keep')
  })

  it('rejects a blank or relative runtime root instead of creating a cache at cwd', () => {
    expect(() => prepareNotebookWorkloadCache('')).toThrow(/absolute runtime root/i)
    expect(() => prepareNotebookWorkloadCache('   ')).toThrow(/absolute runtime root/i)
    expect(() => prepareNotebookWorkloadCache('runtime')).toThrow(/absolute runtime root/i)
  })
})
