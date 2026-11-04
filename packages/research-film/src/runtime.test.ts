import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { narrationRuntimeAssets, prepareNarrationRuntime } from './runtime.js'
import { RESEARCH_NARRATION_MODELS } from './model-catalog.js'
import packageManifest from '../package.json' with { type: 'json' }
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it('keeps inference packages out of default dependencies and selects only one platform and voice', () => {
  for (const name of [
    'kokoro-js',
    '@huggingface/transformers',
    'onnxruntime-node',
    'onnxruntime-web',
    'phonemizer'
  ])
    expect(packageManifest.dependencies).not.toHaveProperty(name)
  for (const target of ['darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64', 'win32/x64']) {
    const assets = narrationRuntimeAssets(target)
    expect(assets.filter((asset) => asset.target).every((asset) => asset.target === target)).toBe(
      true
    )
    expect(
      assets.filter((asset) => asset.path.startsWith('voices/')).map((asset) => asset.path)
    ).toEqual(['voices/af_heart.bin'])
    expect(assets.some((asset) => asset.package === 'onnxruntime-web')).toBe(false)
    expect(assets.reduce((total, asset) => total + asset.size, 0)).toBeLessThan(41_000_000)
    for (const asset of assets) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.file).not.toMatch(/[\\/]/)
      expect(asset.path.split('/')).not.toContain('..')
      expect(asset.url).toMatch(/^https:\/\/(unpkg.com|raw.githubusercontent.com)\//)
    }
  }
  expect(() => narrationRuntimeAssets('unknown/unknown')).toThrow('not supported')
  expect(RESEARCH_NARRATION_MODELS[0].revision).toContain(`${process.platform}-${process.arch}`)
})
it('rejects corrupted executable bytes before loading any downloaded code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'narration-runtime-'))
  roots.push(root)
  const model = join(root, 'model')
  await mkdir(model)
  const asset = narrationRuntimeAssets()[0]
  await writeFile(join(model, asset.file), Buffer.alloc(asset.size))
  await expect(prepareNarrationRuntime(model, join(root, 'runtime'))).rejects.toThrow(
    'checksum failed'
  )
  expect(await readdir(join(root, 'runtime'))).toEqual([])
})
it('reports missing runtime installation without fetching or executing anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'narration-runtime-'))
  roots.push(root)
  await expect(prepareNarrationRuntime(root, join(root, 'runtime'))).rejects.toThrow(
    'Install or update'
  )
  expect(await readdir(join(root, 'runtime'))).toEqual([])
})
