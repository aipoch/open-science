import { afterEach, describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentRuntimeTarget, runtimePackageName } from './runtime-package.mjs'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(
  nativeVersion?: string,
  colocated = false
): Promise<() => Promise<{ entry: string; development: boolean }>> {
  const root = await mkdtemp(join(tmpdir(), 'npm-backend-discovery-'))
  roots.push(root)
  const name = runtimePackageName(currentRuntimeTarget())
  for (const file of ['locate-backend.mjs', 'runtime-package.mjs'])
    await cp(new URL(file, import.meta.url), join(root, file))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      version: '1.2.3',
      optionalDependencies: { '@aipoch/open-science-darwin-arm64': '1.2.3', [name]: '1.2.3' }
    })
  )
  if (nativeVersion) {
    const native = join(root, 'node_modules', name)
    await mkdir(join(native, 'out/backend'), { recursive: true })
    await writeFile(join(native, 'package.json'), JSON.stringify({ name, version: nativeVersion }))
    await writeFile(join(native, 'out/backend/index.cjs'), '')
  }
  if (colocated) {
    await mkdir(join(root, 'out/backend'), { recursive: true })
    await writeFile(join(root, 'out/backend/index.cjs'), '')
  }
  return (await import(pathToFileURL(join(root, 'locate-backend.mjs')).href)).locateBackend
}

describe('installed native backend discovery', () => {
  it('resolves the exact-version platform dependency as a production backend', async () => {
    const result = await (await fixture('1.2.3'))()
    expect(result.development).toBe(false)
    expect(result.entry).toContain('node_modules')
  })
  it('rejects mismatched native package versions', async () => {
    await expect((await fixture('1.2.2'))()).rejects.toThrow('version mismatch')
  })
  it('explains missing optional dependencies', async () => {
    await expect((await fixture())()).rejects.toThrow('--include=optional')
  })
  it('preserves the existing self-contained tarball path', async () => {
    const result = await (await fixture(undefined, true))()
    expect(result.entry).not.toContain('node_modules')
    expect(result.development).toBe(false)
  })
  it('rejects unsupported architectures', () => {
    expect(() => currentRuntimeTarget('win32', 'arm64')).toThrow('no native npm package')
  })
})
