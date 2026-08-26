import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE } from '../../shared/acp'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import {
  HostViewImageService,
  isHostViewImageBackendCertified,
  type HostViewImageBackend,
  type HostViewImageContext,
  type HostViewImageServiceOptions
} from './host-view-image-service'

const visualBackend = (overrides: Partial<HostViewImageBackend> = {}): HostViewImageBackend => ({
  frameworkId: 'claude-code',
  backendId: 'claude-code:provider-a',
  modelRoute: 'claude-anthropic',
  model: 'claude-visual',
  supportsImageInput: true,
  ...overrides
})

const catalogItem = (
  source: 'artifact' | 'upload',
  overrides: Partial<HostArtifactCatalogItem> = {}
): HostArtifactCatalogItem => ({
  source,
  sourceFileId: `${source}-1`,
  versionId: `${source}-version-1`,
  checksum: 'a'.repeat(64),
  projectId: 'project-a',
  sessionId: 'source-session',
  filename: `${source}.png`,
  contentType: 'image/png',
  sizeBytes: 42,
  sortAtMs: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  sourceCreatedAt: '2026-07-01T00:00:00.000Z',
  rootFrameId: source === 'artifact' ? 'root-frame' : null,
  agentFrameId: source === 'artifact' ? 'agent-frame' : null,
  ...overrides
})

let root: string | undefined

type HostViewImageTestHarness = {
  service: HostViewImageService
  readHostArtifactCatalog: ReturnType<typeof vi.fn>
  openLatest: ReturnType<typeof vi.fn>
  closeLatest: ReturnType<typeof vi.fn>
  prepareImage: ReturnType<typeof vi.fn>
  setBackend(next: HostViewImageBackend): void
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const harness = (
  options: {
    backend?: HostViewImageBackend
    items?: HostArtifactCatalogItem[]
    prepareImage?: ReturnType<typeof vi.fn>
    openLatest?: HostViewImageServiceOptions['managedFileVersions']['openLatest']
  } = {}
): HostViewImageTestHarness => {
  let backend = options.backend ?? visualBackend()
  const readHostArtifactCatalog = vi.fn(
    async ({ projectId, versionId }: { projectId: string; versionId?: string }) =>
      (options.items ?? []).filter(
        (item) => item.projectId === projectId && (!versionId || item.versionId === versionId)
      )
  )
  const closeLatest = vi.fn(async () => undefined)
  const openLatest = vi.fn(
    options.openLatest ??
      (async ({ source }: { source: 'artifact' | 'upload' }) => ({
        path: source === 'artifact' ? '/managed/artifact-v2.png' : '/managed/upload-v2.png',
        close: closeLatest
      }))
  )
  const prepareImage =
    options.prepareImage ??
    vi.fn(async () => ({
      data: Buffer.from('png').toString('base64'),
      mimeType: 'image/png' as const,
      originalSize: { width: 20, height: 10 },
      outputSize: { width: 20, height: 10 }
    }))
  const service = new HostViewImageService({
    catalog: { readHostArtifactCatalog },
    managedFileVersions: { openLatest },
    captureBackend: () => backend,
    prepareImage: prepareImage as NonNullable<HostViewImageServiceOptions['prepareImage']>
  })
  return {
    service,
    readHostArtifactCatalog,
    openLatest,
    closeLatest,
    prepareImage,
    setBackend: (next: HostViewImageBackend) => {
      backend = next
    }
  }
}

const context = (
  executionCwd = '/workspace',
  controlInvocationId = 'run-1'
): HostViewImageContext => ({
  projectId: 'project-a',
  sessionId: 'calling-session',
  executionCwd,
  controlInvocationId,
  signal: new AbortController().signal
})

describe('HostViewImageService', () => {
  it.each([
    ['claude-code', 'claude-anthropic'],
    ['opencode', 'opencode-openai'],
    ['opencode', 'opencode-anthropic'],
    ['codex', 'codex-responses'],
    ['codex', 'codex-responses-compatibility']
  ] as const)('certifies the visual %s/%s route', (frameworkId, modelRoute) => {
    expect(
      isHostViewImageBackendCertified(
        visualBackend({ frameworkId, modelRoute, supportsImageInput: true })
      )
    ).toBe(true)
  })

  it('refreshes availability and rejects a stale direct call after a visual-model downgrade', async () => {
    const h = harness()
    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(true)
    h.setBackend(visualBackend({ supportsImageInput: false }))
    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(false)
    await expect(
      h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    ).rejects.toThrow(/select a visual model/u)
  })

  it.each([
    visualBackend({ supportsImageInput: false }),
    visualBackend({ frameworkId: 'codex', modelRoute: 'codex-bridge' }),
    visualBackend({ frameworkId: 'claude-code', modelRoute: 'opencode-openai' }),
    visualBackend({ frameworkId: 'unknown', modelRoute: undefined })
  ])('fails closed for text-only, bridged, mismatched, and unknown routes', (backend) => {
    expect(isHostViewImageBackendCertified(backend)).toBe(false)
  })

  it('keeps the Codex Responses-to-Chat bridge unavailable and rejects a direct call', async () => {
    const h = harness({
      backend: visualBackend({ frameworkId: 'codex', modelRoute: 'codex-bridge' })
    })

    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(false)
    await expect(
      h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    ).rejects.toThrow(/select a visual model/u)
  })

  it('uses historical Version ids only to identify logical files, then opens latest', async () => {
    const artifact = catalogItem('artifact')
    const upload = catalogItem('upload')
    const h = harness({ items: [artifact, upload] })

    await expect(
      h.service.stage({ versionId: artifact.versionId }, undefined, context())
    ).resolves.toMatchObject({ attached: true, sourceKind: 'artifactVersion' })
    await expect(
      h.service.stage({ versionId: upload.versionId }, {}, context('/workspace', 'run-2'))
    ).resolves.toMatchObject({ attached: true, sourceKind: 'uploadVersion' })

    expect(h.readHostArtifactCatalog).toHaveBeenNthCalledWith(1, {
      projectId: 'project-a',
      versionId: artifact.versionId
    })
    expect(h.openLatest).toHaveBeenNthCalledWith(1, {
      source: 'artifact',
      projectId: 'project-a',
      fileId: 'artifact-1'
    })
    expect(h.openLatest).toHaveBeenNthCalledWith(2, {
      source: 'upload',
      projectId: 'project-a',
      fileId: 'upload-1'
    })
    expect(h.prepareImage).toHaveBeenNthCalledWith(
      1,
      '/managed/artifact-v2.png',
      {},
      expect.objectContaining({ aborted: false }),
      undefined
    )
    expect(h.closeLatest).toHaveBeenCalledTimes(2)
  })

  it('closes the latest lease when image preparation fails', async () => {
    const artifact = catalogItem('artifact')
    const h = harness({
      items: [artifact],
      prepareImage: vi.fn(async () => {
        throw new Error('decode failed')
      })
    })

    await expect(h.service.stage({ versionId: artifact.versionId }, {}, context())).rejects.toThrow(
      /could not prepare/u
    )
    expect(h.closeLatest).toHaveBeenCalledOnce()
  })

  it('rejects missing, ambiguous, malformed, and caller-forged source fields', async () => {
    const duplicate = catalogItem('artifact')
    const h = harness({ items: [duplicate, { ...duplicate, sourceFileId: 'artifact-2' }] })

    for (const source of [
      {},
      { versionId: 'missing' },
      { versionId: duplicate.versionId, path: 'image.png' },
      { version_id: duplicate.versionId },
      { path: 'image.png', projectId: 'other-project' },
      'image.png'
    ]) {
      await expect(h.service.stage(source, {}, context())).rejects.toThrow(/host\.viewImage/u)
    }
    await expect(
      h.service.stage({ versionId: duplicate.versionId }, {}, context())
    ).rejects.toThrow(/ambiguous/u)
  })

  it('accepts a code-relative file and rejects application-owned sibling paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'host-view-image-'))
    const workspace = join(root, 'data')
    const handoff = join(root, 'handoff')
    const outside = join(root, 'outside')
    await mkdir(join(workspace, 'results'), { recursive: true })
    await mkdir(handoff)
    await mkdir(outside)
    await writeFile(join(workspace, 'results', 'image.png'), 'image')
    await writeFile(join(handoff, 'connector.png'), 'handoff')
    await writeFile(join(root, 'run.json'), '{}')
    await writeFile(join(outside, 'secret.png'), 'secret')
    await symlink(join(outside, 'secret.png'), join(workspace, 'escape.png'))
    const h = harness()

    await expect(
      h.service.stage({ path: 'results/image.png' }, {}, context(workspace))
    ).resolves.toMatchObject({ attached: true, sourceKind: 'workspacePath' })
    expect(h.prepareImage).toHaveBeenCalledWith(
      await realpath(join(workspace, 'results', 'image.png')),
      {},
      expect.objectContaining({ aborted: false }),
      await realpath(join(workspace, 'results', 'image.png'))
    )

    for (const path of [
      '../outside/secret.png',
      '..\\outside\\secret.png',
      '../handoff/connector.png',
      '..\\handoff\\connector.png',
      '../run.json',
      join(outside, 'secret.png'),
      'C:\\outside\\secret.png',
      '\\\\server\\share\\secret.png',
      'https://example.test/image.png',
      'data:image/png;base64,aA==',
      'escape.png',
      'results'
    ]) {
      await expect(
        h.service.stage({ path }, {}, context(workspace, `run-${path}`))
      ).rejects.toThrow(/host\.viewImage/u)
    }
  })

  it('normalizes the exact camel-case options and rejects unknown or invalid crop values', async () => {
    root = await mkdtemp(join(tmpdir(), 'host-view-image-options-'))
    await writeFile(join(root, 'image.png'), 'image')
    const h = harness()
    const crop = { unit: 'pixels' as const, left: 1, top: 2, right: 10, bottom: 8 }

    await h.service.stage({ path: 'image.png' }, { crop, maxSize: 800 }, context(root))
    expect(h.prepareImage).toHaveBeenCalledWith(
      await realpath(join(root, 'image.png')),
      { crop, maxSize: 800 },
      expect.objectContaining({ aborted: false }),
      await realpath(join(root, 'image.png'))
    )

    for (const options of [
      { max_size: 800 },
      { maxSize: 0 },
      { maxSize: 1569 },
      { crop: { unit: 'pixels', left: 0.5, top: 0, right: 2, bottom: 2 } },
      { crop: { unit: 'fraction', left: -0.1, top: 0, right: 1, bottom: 1 } },
      { crop: { unit: 'fraction', left: 0.5, top: 0, right: 0.5, bottom: 1 } },
      { crop: { unit: 'percent', left: 0, top: 0, right: 1, bottom: 1 } }
    ]) {
      await expect(
        h.service.stage({ path: 'image.png' }, options, context(root, JSON.stringify(options)))
      ).rejects.toThrow(/host\.viewImage/u)
    }
  })

  it('stages in call order, drains once, and discards the whole invocation after a model change', async () => {
    root = await mkdtemp(join(tmpdir(), 'host-view-image-order-'))
    await writeFile(join(root, 'one.png'), 'one')
    await writeFile(join(root, 'two.png'), 'two')
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const prepareImage = vi.fn(async (filePath: string) => {
      const label = filePath.endsWith('one.png') ? 1 : 2
      if (label === 1) {
        markFirstStarted()
        await firstMayFinish
      }
      return {
        data: Buffer.from(String(label)).toString('base64'),
        mimeType: 'image/png' as const,
        originalSize: { width: label, height: label },
        outputSize: { width: label, height: label }
      }
    })
    const h = harness({ prepareImage })

    const first = h.service.stage({ path: 'one.png' }, {}, context(root))
    await firstStarted
    await h.service.stage({ path: 'two.png' }, {}, context(root))
    releaseFirst()
    await first
    await expect(h.service.complete('run-1')).resolves.toEqual([
      expect.objectContaining({ data: Buffer.from('1').toString('base64') }),
      expect.objectContaining({ data: Buffer.from('2').toString('base64') })
    ])
    await expect(h.service.complete('run-1')).resolves.toEqual([])

    await h.service.stage({ path: 'one.png' }, {}, context(root, 'run-model-change'))
    h.setBackend(visualBackend({ model: 'claude-visual-2' }))
    await expect(h.service.complete('run-model-change')).resolves.toEqual([])
  })

  it('discards staged images after an otherwise identical backend generation change', async () => {
    root = await mkdtemp(join(tmpdir(), 'host-view-image-generation-'))
    await writeFile(join(root, 'image.png'), 'image')
    const h = harness({ backend: visualBackend({ generationToken: {} }) })

    await h.service.stage({ path: 'image.png' }, {}, context(root, 'run-generation-change'))
    h.setBackend(visualBackend({ generationToken: {} }))

    await expect(h.service.complete('run-generation-change')).resolves.toEqual([])
  })

  it('enforces four images and clears staged bytes on discard, abort, and shutdown', async () => {
    root = await mkdtemp(join(tmpdir(), 'host-view-image-cleanup-'))
    await writeFile(join(root, 'image.png'), 'image')
    const h = harness()

    for (let index = 0; index < 4; index += 1) {
      await h.service.stage({ path: 'image.png' }, {}, context(root, 'run-budget'))
    }
    await expect(
      h.service.stage({ path: 'image.png' }, {}, context(root, 'run-budget'))
    ).rejects.toThrow(/at most 4 images/u)
    h.service.discard('run-budget')
    await expect(h.service.complete('run-budget')).resolves.toEqual([])

    const aborted = new AbortController()
    aborted.abort()
    await expect(
      h.service.stage(
        { path: 'image.png' },
        {},
        { ...context(root, 'run-abort'), signal: aborted.signal }
      )
    ).rejects.toThrow(/aborted/u)

    await h.service.stage({ path: 'image.png' }, {}, context(root, 'run-shutdown'))
    h.service.shutdown()
    await expect(h.service.complete('run-shutdown')).resolves.toEqual([])
    await expect(
      h.service.stage({ path: 'image.png' }, {}, context(root, 'run-after-shutdown'))
    ).rejects.toThrow(/shut down/u)
  })

  it('keeps staged encoded image bytes within the ACP per-message image budget', async () => {
    root = await mkdtemp(join(tmpdir(), 'host-view-image-acp-budget-'))
    await writeFile(join(root, 'image.png'), 'image')
    const encodedImageBytes = 3 * 1024 * 1024
    const data = Buffer.alloc(encodedImageBytes).toString('base64')
    const h = harness({
      prepareImage: vi.fn(async () => ({
        data,
        mimeType: 'image/png' as const,
        originalSize: { width: 20, height: 10 },
        outputSize: { width: 20, height: 10 }
      }))
    })

    await h.service.stage({ path: 'image.png' }, {}, context(root, 'run-acp-budget'))
    await h.service.stage({ path: 'image.png' }, {}, context(root, 'run-acp-budget'))
    await expect(
      h.service.stage({ path: 'image.png' }, {}, context(root, 'run-acp-budget'))
    ).rejects.toThrow(new RegExp(`${MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE}`, 'u'))
    await expect(h.service.complete('run-acp-budget')).resolves.toHaveLength(2)
  })
})
