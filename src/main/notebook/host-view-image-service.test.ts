import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

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
type PrepareImageMock = Mock<NonNullable<HostViewImageServiceOptions['prepareImage']>>

type HostViewImageTestHarness = {
  service: HostViewImageService
  readHostArtifactCatalog: ReturnType<typeof vi.fn>
  openVersion: ReturnType<typeof vi.fn>
  closeVersion: ReturnType<typeof vi.fn>
  prepareImage: PrepareImageMock
  setBackend(next: HostViewImageBackend): void
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const harness = (
  options: {
    backend?: HostViewImageBackend
    captureBackend?: HostViewImageServiceOptions['captureBackend']
    items?: HostArtifactCatalogItem[]
    prepareImage?: PrepareImageMock
    openVersion?: HostViewImageServiceOptions['managedFileVersions']['openVersion']
    captureVisionRelay?: HostViewImageServiceOptions['captureVisionRelay']
    prepareVisionEvidence?: HostViewImageServiceOptions['prepareVisionEvidence']
  } = {}
): HostViewImageTestHarness => {
  let backend = options.backend ?? visualBackend()
  const readHostArtifactCatalog = vi.fn(
    async ({ projectId, versionId }: { projectId: string; versionId?: string }) =>
      (options.items ?? []).filter(
        (item) => item.projectId === projectId && (!versionId || item.versionId === versionId)
      )
  )
  const closeVersion = vi.fn(async () => undefined)
  const openVersion = vi.fn(
    options.openVersion ??
      (async ({ source }: { source: 'artifact' | 'upload' }) => ({
        path:
          source === 'artifact'
            ? '/managed/artifact-version-1.png'
            : '/managed/upload-version-1.png',
        close: closeVersion
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
    managedFileVersions: { openVersion },
    captureBackend: options.captureBackend ?? (() => backend),
    captureVisionRelay: options.captureVisionRelay,
    prepareVisionEvidence: options.prepareVisionEvidence,
    prepareImage
  })
  return {
    service,
    readHostArtifactCatalog,
    openVersion,
    closeVersion,
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
    ['codex', 'codex-responses-compatibility'],
    ['codex', 'codex-bridge'],
    ['codebuddy', 'codebuddy-openai'],
    ['open-science-agent', 'open-science-agent']
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
    ).rejects.toThrow(/Configure Vision in Settings > Model and retry/u)
  })

  it.each([
    visualBackend({ supportsImageInput: false }),
    visualBackend({
      frameworkId: 'open-science-agent',
      modelRoute: 'open-science-agent',
      supportsImageInput: false
    }),
    visualBackend({ frameworkId: 'open-science-agent', modelRoute: 'opencode-openai' }),
    visualBackend({ frameworkId: 'codex', modelRoute: 'codex-bridge', supportsImageInput: false }),
    visualBackend({ frameworkId: 'claude-code', modelRoute: 'opencode-openai' }),
    visualBackend({ frameworkId: 'unknown', modelRoute: undefined })
  ])('fails closed for text-only, mismatched, and unknown routes', (backend) => {
    expect(isHostViewImageBackendCertified(backend)).toBe(false)
  })

  it('accepts a text-only main model when the app-owned Vision relay is available', async () => {
    const relay = vi.fn(async () => true)
    const h = harness({
      backend: visualBackend({ supportsImageInput: false }),
      items: [catalogItem('artifact')],
      captureVisionRelay: relay,
      prepareVisionEvidence: async () => 'Image evidence'
    })

    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(true)
    await expect(
      h.service.stage(
        { versionId: 'artifact-version-1' },
        {},
        { ...context(), executionCwd: undefined }
      )
    ).resolves.toMatchObject({ attached: true, sourceKind: 'artifactVersion' })
    expect(relay).toHaveBeenCalled()
  })

  it('relays one ordered batch and attaches only Vision evidence to text-only tool results', async () => {
    const prepareVisionEvidence = vi.fn(async () => 'Image 1: a plot. Image 2: a table.')
    const h = harness({
      backend: visualBackend({ supportsImageInput: false }),
      items: [catalogItem('artifact'), catalogItem('upload')],
      captureVisionRelay: () => true,
      prepareVisionEvidence
    })

    await h.service.stage(
      { versionId: 'artifact-version-1' },
      {},
      {
        ...context(),
        executionCwd: undefined
      }
    )
    await h.service.stage({ versionId: 'upload-version-1' }, {}, context())
    await expect(h.service.complete('run-1')).resolves.toEqual([
      { evidence: 'Image 1: a plot. Image 2: a table.' }
    ])
    expect(prepareVisionEvidence).toHaveBeenCalledExactlyOnceWith({
      images: [
        { data: 'cG5n', mimeType: 'image/png' },
        { data: 'cG5n', mimeType: 'image/png' }
      ],
      projectId: 'project-a',
      sessionId: 'calling-session',
      signal: expect.any(AbortSignal)
    })
    await expect(h.service.complete('run-1')).resolves.toEqual([])
  })

  it('reserves call order before asynchronous relay availability checks', async () => {
    let finishFirstCheck!: (available: boolean) => void
    const firstCheck = new Promise<boolean>((resolve) => {
      finishFirstCheck = resolve
    })
    let checkCount = 0
    const prepareVisionEvidence = vi.fn(async () => 'Ordered image evidence')
    const h = harness({
      backend: visualBackend({ supportsImageInput: false }),
      items: [catalogItem('artifact'), catalogItem('upload')],
      captureVisionRelay: () => (++checkCount === 1 ? firstCheck : true),
      prepareVisionEvidence,
      prepareImage: vi.fn(async (filePath: string) => ({
        data: Buffer.from(filePath.includes('artifact') ? 'first' : 'second').toString('base64'),
        mimeType: 'image/png' as const,
        originalSize: { width: 20, height: 10 },
        outputSize: { width: 20, height: 10 }
      }))
    })

    const first = h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    await h.service.stage({ versionId: 'upload-version-1' }, {}, context())
    finishFirstCheck(true)
    await first
    await h.service.complete('run-1')
    expect(prepareVisionEvidence).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        images: [
          { data: Buffer.from('first').toString('base64'), mimeType: 'image/png' },
          { data: Buffer.from('second').toString('base64'), mimeType: 'image/png' }
        ]
      })
    )
  })

  it.each(['discard', 'session', 'shutdown', 'backend'] as const)(
    'keeps %s authoritative while relay availability is pending',
    async (change) => {
      let finishCheck!: (available: boolean) => void
      const check = new Promise<boolean>((resolve) => {
        finishCheck = resolve
      })
      const h = harness({
        backend: visualBackend({ supportsImageInput: false }),
        items: [catalogItem('artifact')],
        captureVisionRelay: () => check,
        prepareVisionEvidence: async () => 'Image evidence'
      })

      const staging = h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
      if (change === 'discard') h.service.discard('run-1')
      else if (change === 'session') h.service.discardSession('calling-session')
      else if (change === 'shutdown') h.service.shutdown()
      else h.setBackend(visualBackend({ supportsImageInput: false, model: 'changed-model' }))
      finishCheck(true)
      await expect(staging).rejects.toThrow(change === 'backend' ? /changed/u : /aborted/u)
      expect(h.readHostArtifactCatalog).not.toHaveBeenCalled()
      expect(h.openVersion).not.toHaveBeenCalled()
      expect(h.prepareImage).not.toHaveBeenCalled()
      await expect(h.service.complete('run-1')).resolves.toEqual([])
    }
  )

  it('keeps native image completion independent of the Vision relay', async () => {
    const captureVisionRelay = vi.fn(async () => {
      throw new Error('Vision relay must not be consulted for native images')
    })
    const prepareVisionEvidence = vi.fn(async () => 'unused evidence')
    const h = harness({
      items: [catalogItem('artifact')],
      captureVisionRelay,
      prepareVisionEvidence
    })

    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(true)
    await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    await expect(h.service.complete('run-1')).resolves.toEqual([
      { data: 'cG5n', mimeType: 'image/png' }
    ])
    expect(captureVisionRelay).not.toHaveBeenCalled()
    expect(prepareVisionEvidence).not.toHaveBeenCalled()
  })

  it('requires an installed evidence producer even when relay capability is available', async () => {
    const h = harness({
      backend: visualBackend({ supportsImageInput: false }),
      items: [catalogItem('artifact')],
      captureVisionRelay: () => true
    })

    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(false)
    await expect(
      h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    ).rejects.toThrow(/Configure Vision in Settings > Model/u)
    await expect(h.service.complete('run-1')).resolves.toEqual([])
    expect(h.prepareImage).not.toHaveBeenCalled()
  })

  it.each([undefined, '', ' \n '])(
    'fails closed when the relay returns missing or blank evidence (%j)',
    async (evidence) => {
      const h = harness({
        backend: visualBackend({ supportsImageInput: false }),
        items: [catalogItem('artifact')],
        captureVisionRelay: () => true,
        prepareVisionEvidence: async () => evidence
      })

      await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
      await expect(h.service.complete('run-1')).rejects.toThrow(/no image evidence/u)
      await expect(h.service.complete('run-1')).resolves.toEqual([])
    }
  )

  it.each([
    new Error('Vision request failed with private image data: cG5n'),
    new DOMException('Vision request aborted with private image data: cG5n', 'AbortError')
  ])('fails closed when the Vision relay is removed or rejects with %s', async (providerError) => {
    let available = true
    let relaySignal: AbortSignal | undefined
    const prepareVisionEvidence = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      relaySignal = signal
      throw providerError
    })
    const h = harness({
      backend: visualBackend({ supportsImageInput: false }),
      items: [catalogItem('artifact')],
      captureVisionRelay: () => available,
      prepareVisionEvidence
    })

    await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    available = false
    await expect(h.service.complete('run-1')).rejects.toThrow(/relay is unavailable/u)
    expect(prepareVisionEvidence).not.toHaveBeenCalled()
    available = true
    await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    await expect(h.service.complete('run-1')).rejects.toMatchObject({
      message: 'host.viewImage could not prepare Vision evidence for the current model.',
      cause: providerError
    })
    expect(relaySignal?.aborted).toBe(true)
    await expect(h.service.complete('run-1')).resolves.toEqual([])
  })

  it.each(['model', 'generation'] as const)(
    'discards evidence when the backend %s changes during relay analysis',
    async (change) => {
      let finishAnalysis!: (evidence: string) => void
      let analysisStarted!: () => void
      const started = new Promise<void>((resolve) => {
        analysisStarted = resolve
      })
      const backend = visualBackend({ supportsImageInput: false, generationToken: {} })
      const h = harness({
        backend,
        items: [catalogItem('artifact')],
        captureVisionRelay: () => true,
        prepareVisionEvidence: () => {
          analysisStarted()
          return new Promise<string>((resolve) => {
            finishAnalysis = resolve
          })
        }
      })

      await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
      const completing = h.service.complete('run-1')
      await started
      h.setBackend({
        ...backend,
        ...(change === 'model' ? { model: 'another-model' } : { generationToken: {} })
      })
      finishAnalysis('stale image evidence')
      await expect(completing).resolves.toEqual([])
      await expect(h.service.complete('run-1')).resolves.toEqual([])
    }
  )

  it.each(['completion signal', 'discard', 'session', 'shutdown'] as const)(
    'cancels in-flight relay analysis on %s and refuses late evidence',
    async (cancellation) => {
      const controller = new AbortController()
      let finishAnalysis!: (evidence: string) => void
      let analysisStarted!: () => void
      let relaySignal: AbortSignal | undefined
      const started = new Promise<void>((resolve) => {
        analysisStarted = resolve
      })
      const h = harness({
        backend: visualBackend({ supportsImageInput: false }),
        items: [catalogItem('artifact')],
        captureVisionRelay: () => true,
        prepareVisionEvidence: ({ signal }) => {
          relaySignal = signal
          analysisStarted()
          return new Promise<string>((resolve) => {
            finishAnalysis = resolve
          })
        }
      })

      await h.service.stage(
        { versionId: 'artifact-version-1' },
        {},
        {
          ...context(),
          signal:
            cancellation === 'completion signal' ? new AbortController().signal : controller.signal
        }
      )
      const completing = h.service.complete(
        'run-1',
        cancellation === 'completion signal' ? controller.signal : undefined
      )
      await started
      const reason = new Error('private cancellation reason cG5n')
      if (cancellation === 'completion signal') controller.abort(reason)
      else if (cancellation === 'discard') h.service.discard('run-1')
      else if (cancellation === 'session') h.service.discardSession('calling-session')
      else h.service.shutdown()
      expect(relaySignal?.aborted).toBe(true)
      finishAnalysis('late image evidence')
      if (cancellation === 'completion signal') await expect(completing).rejects.toBe(reason)
      else {
        await expect(completing).rejects.toMatchObject({
          name: 'AbortError',
          message: 'host.viewImage image inspection was aborted.'
        })
      }
      await expect(h.service.complete('run-1')).resolves.toEqual([])
    }
  )

  it.each([false, true])(
    'completes the first image before an aborted second RPC settles (native images: %s)',
    async (native) => {
      const prepareVisionEvidence = vi.fn(async ({ images }) => `Inspected ${images.length} image`)
      const h = harness({
        backend: visualBackend({ supportsImageInput: native }),
        items: [catalogItem('artifact'), catalogItem('upload')],
        captureVisionRelay: () => true,
        prepareVisionEvidence
      })
      const firstRpc = new AbortController()
      await h.service.stage(
        { versionId: 'artifact-version-1' },
        {},
        { ...context(), signal: firstRpc.signal }
      )
      // A transport can disconnect after its successful stage response, too.
      firstRpc.abort()
      let finishSecond!: () => void
      let secondStarted!: () => void
      const started = new Promise<void>((resolve) => {
        secondStarted = resolve
      })
      const pending = new Promise<void>((resolve) => {
        finishSecond = resolve
      })
      h.prepareImage.mockImplementationOnce(async () => {
        secondStarted()
        await pending
        // A provider may ignore cancellation and return the prepared image late.
        return {
          data: Buffer.from('late image').toString('base64'),
          mimeType: 'image/png',
          originalSize: { width: 20, height: 10 },
          outputSize: { width: 20, height: 10 }
        }
      })
      const secondRpc = new AbortController()
      const second = h.service.stage(
        { versionId: 'upload-version-1' },
        {},
        { ...context(), signal: secondRpc.signal }
      )
      await started
      secondRpc.abort()
      await expect(h.service.complete('run-1')).resolves.toEqual(
        native ? [{ data: 'cG5n', mimeType: 'image/png' }] : [{ evidence: 'Inspected 1 image' }]
      )
      if (native) expect(prepareVisionEvidence).not.toHaveBeenCalled()
      else {
        expect(prepareVisionEvidence).toHaveBeenCalledWith(
          expect.objectContaining({ images: [{ data: 'cG5n', mimeType: 'image/png' }] })
        )
      }
      finishSecond()
      await expect(second).rejects.toMatchObject({ name: 'AbortError' })
      await expect(h.service.complete('run-1')).resolves.toEqual([])
    }
  )

  it.each([false, true])(
    'keeps whole-batch Stop authoritative before an aborted RPC settles (native images: %s)',
    async (native) => {
      const backend = visualBackend({ supportsImageInput: native })
      let completing = false
      let finishBackend!: (backend: HostViewImageBackend) => void
      let completionStarted!: () => void
      const startedCompletion = new Promise<void>((resolve) => {
        completionStarted = resolve
      })
      const pendingBackend = new Promise<HostViewImageBackend>((resolve) => {
        finishBackend = resolve
      })
      const prepareVisionEvidence = vi.fn(async () => 'unexpected evidence')
      const h = harness({
        captureBackend: () => {
          if (!completing) return backend
          completionStarted()
          return pendingBackend
        },
        items: [catalogItem('artifact'), catalogItem('upload')],
        captureVisionRelay: () => true,
        prepareVisionEvidence
      })
      await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
      let secondStarted!: () => void
      let finishSecond!: () => void
      const startedSecond = new Promise<void>((resolve) => {
        secondStarted = resolve
      })
      const pendingSecond = new Promise<void>((resolve) => {
        finishSecond = resolve
      })
      h.prepareImage.mockImplementationOnce(async () => {
        secondStarted()
        await pendingSecond
        return {
          data: Buffer.from('late image').toString('base64'),
          mimeType: 'image/png',
          originalSize: { width: 20, height: 10 },
          outputSize: { width: 20, height: 10 }
        }
      })
      const rpc = new AbortController()
      const second = h.service.stage(
        { versionId: 'upload-version-1' },
        {},
        { ...context(), signal: rpc.signal }
      )
      await startedSecond
      rpc.abort()
      completing = true
      const stop = new AbortController()
      const completion = h.service.complete('run-1', stop.signal)
      await startedCompletion
      const reason = new Error('foreground caller stopped')
      stop.abort(reason)
      finishSecond()
      await expect(second).rejects.toMatchObject({ name: 'AbortError' })
      finishBackend(backend)
      await expect(completion).rejects.toBe(reason)
      expect(prepareVisionEvidence).not.toHaveBeenCalled()
      await expect(h.service.complete('run-1')).resolves.toEqual([])
    }
  )

  it('points a supported text-only route without a Vision model to its configuration', async () => {
    const h = harness({
      backend: visualBackend({ supportsImageInput: false }),
      captureVisionRelay: () => false,
      prepareVisionEvidence: vi.fn()
    })
    await expect(h.service.isAvailable(context())).resolves.toBe(false)
    await expect(h.service.stage({ path: 'plot.png' }, {}, context())).rejects.toThrow(
      'Configure Vision in Settings > Model and retry.'
    )
    expect(h.prepareImage).not.toHaveBeenCalled()
    h.setBackend(visualBackend({ frameworkId: 'unknown' }))
    await expect(h.service.stage({ path: 'plot.png' }, {}, context())).rejects.toThrow(
      /select a visual model on a certified provider path/u
    )
  })

  it('rejects a native backend generation change during asynchronous completion checks', async () => {
    const initial = visualBackend({ generationToken: {} })
    const successor = visualBackend({ generationToken: {} })
    const captureBackend = vi.fn(() => initial)
    const h = harness({ items: [catalogItem('artifact')], captureBackend })
    await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    captureBackend.mockReturnValueOnce(initial).mockReturnValue(successor)
    await expect(h.service.complete('run-1')).resolves.toEqual([])
  })

  it.each([false, true])(
    'honors an already stopped completion only when images were staged (%s)',
    async (staged) => {
      const prepareVisionEvidence = vi.fn(async () => 'image evidence')
      const h = harness({
        backend: visualBackend({ supportsImageInput: false }),
        items: [catalogItem('artifact')],
        captureVisionRelay: () => true,
        prepareVisionEvidence
      })
      if (staged) await h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
      const stop = new AbortController()
      const reason = new Error('foreground caller stopped')
      stop.abort(reason)

      const completing = h.service.complete('run-1', stop.signal)

      if (staged) await expect(completing).rejects.toBe(reason)
      else await expect(completing).resolves.toEqual([])
      expect(prepareVisionEvidence).not.toHaveBeenCalled()
      await expect(h.service.complete('run-1')).resolves.toEqual([])
    }
  )

  it('delivers native images through the Codex Chat bridge and rejects text-only models', async () => {
    const backend = visualBackend({ frameworkId: 'codex', modelRoute: 'codex-bridge' })
    const h = harness({ backend, items: [catalogItem('artifact')] })

    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(true)
    await expect(
      h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    ).resolves.toMatchObject({ attached: true, sourceKind: 'artifactVersion' })
    await expect(h.service.complete('run-1')).resolves.toEqual([
      { data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }
    ])
    await expect(h.service.complete('run-1')).resolves.toEqual([])

    h.setBackend({ ...backend, supportsImageInput: false })
    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(false)
    await expect(
      h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    ).rejects.toThrow(/Configure Vision in Settings > Model/u)
  })

  it('stages images for a visual CodeBuddy backend', async () => {
    const h = harness({
      backend: visualBackend({ frameworkId: 'codebuddy', modelRoute: 'codebuddy-openai' }),
      items: [catalogItem('artifact')]
    })

    await expect(h.service.isAvailable({ sessionId: 'calling-session' })).resolves.toBe(true)
    await expect(
      h.service.stage({ versionId: 'artifact-version-1' }, {}, context())
    ).resolves.toMatchObject({ attached: true, sourceKind: 'artifactVersion' })
  })

  it('opens the exact requested historical image version for artifacts and uploads', async () => {
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
    expect(h.openVersion).toHaveBeenNthCalledWith(
      1,
      {
        source: 'artifact',
        projectId: 'project-a',
        fileId: 'artifact-1'
      },
      artifact.versionId
    )
    expect(h.openVersion).toHaveBeenNthCalledWith(
      2,
      {
        source: 'upload',
        projectId: 'project-a',
        fileId: 'upload-1'
      },
      upload.versionId
    )
    expect(h.prepareImage).toHaveBeenNthCalledWith(
      1,
      '/managed/artifact-version-1.png',
      {},
      expect.objectContaining({ aborted: false }),
      undefined
    )
    expect(h.closeVersion).toHaveBeenCalledTimes(2)
  })

  it('opens a versionId without an execution workspace while keeping path sources gated', async () => {
    const artifact = catalogItem('artifact')
    const h = harness({ items: [artifact] })
    await expect(
      h.service.stage(
        { versionId: artifact.versionId },
        {},
        { ...context(), executionCwd: undefined }
      )
    ).resolves.toMatchObject({ attached: true, sourceKind: 'artifactVersion' })
    await expect(h.service.stage({ path: 'image.png' }, {}, { ...context('') })).rejects.toThrow(
      /trusted execution workspace/u
    )
  })

  it('closes the version lease when image preparation fails', async () => {
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
    expect(h.closeVersion).toHaveBeenCalledOnce()
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
