import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { load } from 'js-yaml'
import {
  readNarrationCatalog,
  publishNarrationAssets,
  checkNarrationCdn
} from './publish-narration-assets.mjs'
import {
  researchNarrationCdnUrl,
  localModelDownloadSources
} from '../src/main/local-models/download-sources'

const bytes = Buffer.from('narration fixture')
const asset = {
  file: 'model.onnx',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  url: ''
}
asset.url = researchNarrationCdnUrl(asset)
const environment = {
  CDN_BASE_URL: 'https://statics.aipoch.com',
  S3_PREFIX: 'open-science/app/stable',
  S3_BUCKET: 'fixture-bucket'
}
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const stage = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'narration-publish-'))
  roots.push(root)
  await mkdir(join(root, asset.sha256))
  await writeFile(join(root, asset.sha256, asset.file), bytes)
  return root
}

it('deduplicates the platform catalogs and uses the same URLs as the client', async () => {
  const catalog = await readNarrationCatalog()
  expect(new Set(catalog.assets.map((entry) => entry.url)).size).toBe(catalog.assets.length)
  expect(catalog.assets.filter((entry) => entry.file === 'model_quantized.onnx')).toHaveLength(1)
  for (const entry of catalog.assets) expect(entry.url).toBe(researchNarrationCdnUrl(entry))
  const { RESEARCH_NARRATION_MODELS } =
    await import('../packages/research-film/dist/model-catalog.js')
  const published = new Set(catalog.assets.map((entry) => entry.url))
  for (const revision of RESEARCH_NARRATION_MODELS) {
    for (const entry of revision.assets) {
      const [primary] = localModelDownloadSources(entry, 'research-narration')
      if (entry.url.startsWith('https://unpkg.com/onnxruntime-node@1.21.0/')) {
        expect(primary).toContain('https://registry.npmmirror.com/onnxruntime-node/1.21.0/files/')
        expect(published.has(researchNarrationCdnUrl(entry))).toBe(false)
      } else expect(published.has(primary)).toBe(true)
    }
  }
})

it('creates missing objects with conditional writes and pinned checksums', async () => {
  const root = await stage()
  const invoke = vi
    .fn()
    .mockReturnValueOnce({ status: 1, stderr: '(404)' })
    .mockReturnValue({ status: 0, stdout: '{}' })
  await publishNarrationAssets(root, { assets: [asset] }, environment, invoke)
  const args = invoke.mock.calls[1][1]
  expect(args).toContain('put-object')
  expect(args).toContain('--if-none-match')
  expect(args).toContain('*')
  expect(args).toContain(Buffer.from(asset.sha256, 'hex').toString('base64'))
  expect(args).toContain(new URL(asset.url).pathname.slice(1))
})

it('reuses identical objects and refuses conflicting existing bytes', async () => {
  const root = await stage()
  const invoke = vi.fn().mockReturnValue({
    status: 0,
    stdout: JSON.stringify({
      ContentLength: asset.size,
      ChecksumSHA256: Buffer.from(asset.sha256, 'hex').toString('base64')
    })
  })
  await publishNarrationAssets(root, { assets: [asset] }, environment, invoke)
  expect(invoke).toHaveBeenCalledOnce()
  invoke.mockReturnValue({ status: 0, stdout: '{}' })
  await expect(
    publishNarrationAssets(root, { assets: [asset] }, environment, invoke)
  ).rejects.toThrow('differ')
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('refuses writes after corrupt staging bytes, forbidden HEAD or wrong destination', async () => {
  const root = await stage()
  const invoke = vi.fn().mockReturnValue({ status: 1, stderr: '(403) Forbidden' })
  await expect(
    publishNarrationAssets(root, { assets: [asset] }, environment, invoke)
  ).rejects.toThrow('Cannot inspect')
  expect(invoke).toHaveBeenCalledOnce()
  invoke.mockClear()
  await writeFile(join(root, asset.sha256, asset.file), Buffer.alloc(bytes.length))
  await expect(
    publishNarrationAssets(root, { assets: [asset] }, environment, invoke)
  ).rejects.toThrow('catalog')
  await expect(
    publishNarrationAssets(
      root,
      { assets: [asset] },
      { ...environment, CDN_BASE_URL: 'https://wrong.test' },
      invoke
    )
  ).rejects.toThrow('configuration')
  expect(invoke).not.toHaveBeenCalled()
})

it('verifies served bytes rather than trusting CDN response metadata', async () => {
  await checkNarrationCdn({ assets: [asset] }, async () => new Response(bytes), {
    verifyBytes: true
  })
  await expect(
    checkNarrationCdn({ assets: [asset] }, async () => new Response(Buffer.alloc(bytes.length)), {
      verifyBytes: true
    })
  ).rejects.toThrow('SHA-256')
})

it('publishes the immutable workflow revision without a separate source-ref override', async () => {
  const workflow = load(await readFile('.github/workflows/research-narration-cdn.yml', 'utf8')) as {
    on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } }
    jobs: {
      publish: {
        steps: { name: string; uses?: string; with?: Record<string, unknown>; if?: string }[]
      }
    }
  }
  expect(workflow.on.workflow_dispatch.inputs.ref).toBeUndefined()
  expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
  const steps = workflow.jobs.publish.steps
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))!
  expect(checkout.with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false })
  for (const name of ['Configure AWS credentials', 'Publish immutable narration assets']) {
    expect(steps.find((step) => step.name === name)?.if).toBe('${{ !inputs.dry_run }}')
  }
})
