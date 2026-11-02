import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { load } from 'js-yaml'
import {
  checkOcrCdn,
  publishOcrAssets,
  validateOcrCatalog,
  verifyOcrAssets
} from './publish-ocr-assets.mjs'

type Asset = { file: string; url: string; size: number; sha256: string }
type Workflow = {
  on: { workflow_dispatch: { inputs: { dry_run: { default: boolean } } } }
  jobs: Record<string, { steps: { name: string; if?: string; with?: { path?: string } }[] }>
}

const environment = {
  CDN_BASE_URL: 'https://cdn.fixture.test',
  S3_PREFIX: 'fixture-app/app/stable',
  S3_BUCKET: 'fixture-bucket'
}
const files = ['licenses.txt', 'ocr-engine.mjs', 'ocr-worker.mjs']
const asset = (file: string, content: string): Asset => {
  const sha256 = createHash('sha256').update(content).digest('hex')
  return {
    file,
    url: `${environment.CDN_BASE_URL}/fixture-app/ocr/${sha256}/${file}`,
    size: Buffer.byteLength(content),
    sha256
  }
}

const contents = new Map(files.map((file) => [file, `${file} fixture`]))
const assets = files.map((file) => asset(file, contents.get(file)!))
const catalog = { revision: 'ocr-0123456789abcdef', assets }

it.each([undefined, '7'])(
  'verifies decoded CDN bytes with compressed content-length %s',
  async (length) => {
    const fetchImpl = vi.fn(async (url: string) => {
      const item = assets.find((entry) => entry.url === url)!
      return new Response(contents.get(item.file), {
        headers: {
          'content-encoding': 'br',
          ...(length ? { 'content-length': length } : {})
        }
      })
    })
    await expect(checkOcrCdn(catalog, fetchImpl, { verifyBytes: true })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      assets[0].url,
      expect.objectContaining({ method: 'GET' })
    )
  }
)

it.each(['truncated', 'oversized', 'corrupt', 'unavailable'])(
  'rejects %s CDN responses even with the expected content-length',
  async (mode) => {
    const item = assets[0]
    const content = contents.get(item.file)!
    const body =
      mode === 'truncated'
        ? content.slice(1)
        : mode === 'oversized'
          ? content + 'x'
          : 'x'.repeat(item.size)
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          status: mode === 'unavailable' ? 403 : 200,
          headers: { 'content-length': String(item.size) }
        })
    )
    await expect(checkOcrCdn({ assets: [item] }, fetchImpl, { verifyBytes: true })).rejects.toThrow(
      mode === 'corrupt' ? 'wrong SHA-256' : 'unavailable or has the wrong size'
    )
  }
)

it('retains content-length checks for HEAD probes', async () => {
  const item = assets[0]
  const fetchImpl = vi.fn(
    async () =>
      new Response(null, {
        headers: { 'content-length': String(item.size) }
      })
  )
  await expect(checkOcrCdn({ assets: [item] }, fetchImpl)).resolves.toBeUndefined()
  expect(fetchImpl).toHaveBeenCalledWith(item.url, expect.objectContaining({ method: 'HEAD' }))
  await expect(checkOcrCdn({ assets: [item] }, async () => new Response(null))).rejects.toThrow(
    'unavailable or has the wrong size'
  )
})

it('accepts only the three content-addressed first-party assets', () => {
  expect(validateOcrCatalog(catalog, environment)).toEqual(catalog)
  expect(() =>
    validateOcrCatalog(
      { ...catalog, assets: assets.filter((item) => item.file !== 'licenses.txt') },
      environment
    )
  ).toThrow('exactly the three first-party assets')
  expect(() =>
    validateOcrCatalog(
      {
        ...catalog,
        assets: [...assets, asset('eng.traineddata.gz', 'language fixture')].map((item) =>
          item.file === 'eng.traineddata.gz'
            ? {
                ...item,
                url: `${environment.CDN_BASE_URL}/fixture-app/ocr/${item.sha256}/${item.file}`
              }
            : item
        )
      },
      environment
    )
  ).toThrow('must not use the project CDN')
})

it('verifies local bytes and publishes missing objects create-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ocr-cdn-'))
  try {
    for (const [file, content] of contents) await writeFile(join(directory, file), content)
    await verifyOcrAssets(directory, catalog)
    const invoke = vi.fn((_command: string, args: string[]) =>
      args.includes('head-object')
        ? { status: 1, stderr: '(404) Not Found' }
        : { status: 0, stdout: '{}' }
    )
    await publishOcrAssets(directory, catalog, environment, invoke)
    const putCalls = invoke.mock.calls.filter(([, args]) => args.includes('put-object'))
    expect(putCalls).toHaveLength(3)
    expect(putCalls[0]?.[1]).toEqual(expect.arrayContaining(['--if-none-match', '*']))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps publication dry-run by default and verifies after publication', async () => {
  const workflow = load(await readFile('.github/workflows/ocr-cdn.yml', 'utf8')) as Workflow
  expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
  const steps = workflow.jobs.publish.steps
  expect(steps.find((step) => step.name === 'Install OCR build dependencies')?.run).toContain(
    'node node_modules/patch-package/index.js --error-on-fail'
  )
  expect(steps.find((step) => step.name === 'Publish immutable OCR assets')?.if).toBe(
    '${{ !inputs.dry_run }}'
  )
  expect(steps.find((step) => step.name === 'Upload verified candidates')?.with).toEqual(
    expect.objectContaining({
      path: expect.stringContaining('out/ocr/licenses.txt')
    })
  )
  expect(steps.find((step) => step.name === 'Upload verified candidates')?.with?.path).not.toBe(
    'out/ocr'
  )
  expect(JSON.stringify(workflow)).not.toContain('contents: write')
})
