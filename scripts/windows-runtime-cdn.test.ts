import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { load } from 'js-yaml'

type Workflow = {
  on: { workflow_dispatch: { inputs: { dry_run: { default: boolean } } } }
  jobs: Record<
    string,
    {
      needs?: string[]
      env?: Record<string, string>
      steps: { name: string; if?: string; run?: string; env?: Record<string, string> }[]
    }
  >
}
import {
  checkRuntimeCdn,
  publishRuntimeArchives,
  readRuntimeCatalog,
  runtimeArchiveUrl,
  verifyRuntimeArchives
} from './windows-runtime-cdn.mjs'

const content = 'signed fixture archive'
const digest = createHash('sha256').update(content).digest('hex')
const destination = {
  CDN_BASE_URL: 'https://cdn.fixture.test',
  S3_BUCKET: 'fixture-bucket',
  S3_PREFIX: 'fixture-app/app/stable'
}
const catalog = {
  schema: 1,
  releases: [
    {
      component: 'node',
      architecture: 'x64',
      archive: {
        url: `${destination.CDN_BASE_URL}/fixture-app/notebook-runtime/node/win32-x64/${digest}/node.tar.zst`,
        sha256: digest,
        size: content.length
      }
    }
  ]
}

it('validates the catalog against the configured CDN origin and application prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cdn-catalog-'))
  const path = join(directory, 'catalog.json')
  try {
    await writeFile(path, JSON.stringify(catalog))
    expect((await readRuntimeCatalog(destination, path)).releases[0].archive.url).toBe(
      catalog.releases[0].archive.url
    )
    await expect(
      readRuntimeCatalog({ ...destination, CDN_BASE_URL: 'https://other.fixture.test' }, path)
    ).rejects.toThrow('immutable runtime URL')
    await expect(
      readRuntimeCatalog({ ...destination, S3_PREFIX: 'different/app/stable' }, path)
    ).rejects.toThrow('immutable runtime URL')
    await expect(readRuntimeCatalog({}, path)).rejects.toThrow('CDN_BASE_URL and S3_PREFIX')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([
  { CDN_BASE_URL: 'http://cdn.fixture.test' },
  { CDN_BASE_URL: 'https://user:pass@cdn.fixture.test' },
  { CDN_BASE_URL: 'https://cdn.fixture.test/path' },
  { CDN_BASE_URL: 'https://cdn.fixture.test/?query=1' },
  { CDN_BASE_URL: 'https://cdn.fixture.test/#fragment' },
  { S3_PREFIX: '../app/stable' },
  { S3_PREFIX: '' }
])('rejects invalid CDN deployment configuration: %j', (override) => {
  expect(() => runtimeArchiveUrl('node', 'x64', digest, { ...destination, ...override })).toThrow()
})

it('uses the same configured immutable URL for staging and publication', () => {
  expect(runtimeArchiveUrl('node', 'x64', digest, destination)).toBe(
    catalog.releases[0].archive.url
  )
  expect(
    runtimeArchiveUrl('node', 'x64', digest, {
      ...destination,
      CDN_BASE_URL: `${destination.CDN_BASE_URL}/`
    })
  ).toBe(catalog.releases[0].archive.url)
})

it('rejects a mismatched publication destination before invoking object storage', async () => {
  const invoke = vi.fn()
  await expect(
    publishRuntimeArchives(
      'unused-fixture',
      catalog,
      { ...destination, S3_PREFIX: 'different/app/stable' },
      invoke
    )
  ).rejects.toThrow('immutable runtime URL')
  expect(invoke).not.toHaveBeenCalled()
})

it('rejects missing or wrong-sized CDN objects before application packaging', async () => {
  await expect(
    checkRuntimeCdn(catalog, async () => new Response(null, { status: 404 }))
  ).rejects.toThrow('unavailable')
  await expect(
    checkRuntimeCdn(catalog, async () => new Response(null, { headers: { 'content-length': '1' } }))
  ).rejects.toThrow('wrong size')
  const request = vi.fn(
    async () => new Response(null, { headers: { 'content-length': String(content.length) } })
  )
  await checkRuntimeCdn(catalog, request)
  expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD', redirect: 'error' })
})

it('downloads and hashes CDN objects when release preflight requests byte verification', async () => {
  const matching = vi.fn(
    async () => new Response(content, { headers: { 'content-length': String(content.length) } })
  )
  await checkRuntimeCdn(catalog, matching, { verifyBytes: true })
  expect(matching.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' })

  await expect(
    checkRuntimeCdn(
      catalog,
      async () =>
        new Response('tampered', { headers: { 'content-length': String(content.length) } }),
      { verifyBytes: true }
    )
  ).rejects.toThrow('wrong SHA-256')
})

it('publishes only verified archives with S3 create-only and checksum conditions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cdn-publish-'))
  try {
    await writeFile(join(directory, 'node.tar.zst'), content)
    const invoke = vi.fn((_command, args) =>
      args.includes('head-object')
        ? { status: 1, stderr: '(404) Not Found' }
        : { status: 0, stdout: '{}' }
    )
    await publishRuntimeArchives(directory, catalog, destination, invoke)
    const put = invoke.mock.calls.find(([, args]) => args.includes('put-object'))![1]
    expect(put).toEqual(
      expect.arrayContaining([
        '--if-none-match',
        '*',
        '--checksum-sha256',
        Buffer.from(digest, 'hex').toString('base64')
      ])
    )
    await writeFile(join(directory, 'node.tar.zst'), 'corrupt')
    invoke.mockClear()
    await expect(publishRuntimeArchives(directory, catalog, destination, invoke)).rejects.toThrow(
      'reviewed catalog'
    )
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['different', 'identical', 'denied'] as const)(
  'preserves an existing or uninspectable object: %s',
  async (state) => {
    const directory = await mkdtemp(join(tmpdir(), 'cdn-existing-'))
    try {
      await writeFile(join(directory, 'node.tar.zst'), content)
      await verifyRuntimeArchives(directory, catalog)
      const invoke = vi.fn(() =>
        state === 'denied'
          ? { status: 1, stderr: '(403) Forbidden' }
          : {
              status: 0,
              stdout: JSON.stringify({
                ContentLength: content.length,
                ChecksumSHA256:
                  state === 'identical'
                    ? Buffer.from(digest, 'hex').toString('base64')
                    : 'different'
              })
            }
      )
      const operation = publishRuntimeArchives(directory, catalog, destination, invoke)
      if (state === 'identical') await operation
      else await expect(operation).rejects.toThrow()
      expect(invoke).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it('reports an inspection timeout without disclosing credentials or attempting upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cdn-timeout-'))
  try {
    await writeFile(join(directory, 'node.tar.zst'), content)
    const invoke = vi.fn(() => ({
      status: null,
      error: { code: 'ETIMEDOUT' },
      stderr: 'fixture-bucket fixture-access fixture-secret fixture-token'
    }))
    const outcome = publishRuntimeArchives(
      directory,
      catalog,
      {
        ...destination,
        AWS_ACCESS_KEY_ID: 'fixture-access',
        AWS_SECRET_ACCESS_KEY: 'fixture-secret',
        AWS_SESSION_TOKEN: 'fixture-token'
      },
      invoke
    )
    await expect(outcome).rejects.toThrow('ETIMEDOUT: [redacted] [redacted] [redacted] [redacted]')
    expect(invoke).toHaveBeenCalledOnce()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps CDN preparation separate from releases and defaults to a non-publishing dry run', async () => {
  const workflow = load(
    await readFile('.github/workflows/windows-runtime-cdn.yml', 'utf8')
  ) as Workflow
  expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
  expect(workflow.jobs.stage.env).toMatchObject({
    CDN_BASE_URL: '${{ vars.CDN_BASE_URL }}',
    S3_PREFIX: '${{ vars.S3_PREFIX }}'
  })
  const steps = workflow.jobs.stage.steps
  expect(steps.find((step) => step.name === 'Publish immutable CDN components').if).toBe(
    '${{ !inputs.dry_run }}'
  )
  expect(steps.findIndex((step) => step.name === 'Upload verified candidates')).toBeLessThan(
    steps.findIndex((step) => step.name === 'Publish immutable CDN components')
  )
  expect(JSON.stringify(workflow)).not.toContain('contents: write')
  const build = load(await readFile('.github/workflows/build.yml', 'utf8')) as Workflow
  expect(build.jobs.windows_notebook_runtime).toBeUndefined()
  expect(build.jobs.build.needs).not.toContain('windows_notebook_runtime')
  expect(
    build.jobs.build.steps.find((step) => step.name === 'Verify Windows runtime CDN availability')
      .run
  ).toBe('node scripts/windows-runtime-cdn.mjs check')
  expect(
    build.jobs.build.steps.find((step) => step.name === 'Verify Windows runtime CDN availability')
      .env
  ).toMatchObject({
    CDN_BASE_URL: '${{ vars.CDN_BASE_URL }}',
    S3_PREFIX: '${{ vars.S3_PREFIX }}'
  })
  const packaging = await readFile('electron-builder.yml', 'utf8')
  expect(packaging).not.toContain('to: notebook-runtime')
  const entry = load(await readFile('.github/workflows/stage-runtime-bundle.yml', 'utf8')) as {
    jobs: Record<string, { if: string; with?: { dry_run: string }; uses?: string }>
  }
  expect(entry.jobs.windows_components.uses).toBe('./.github/workflows/windows-runtime-cdn.yml')
  expect(entry.jobs.windows_components.with?.dry_run).toBe('${{ inputs.dry_run }}')
  expect(entry.jobs.setup.if).toContain("inputs.windows_runtime_run == ''")
})
