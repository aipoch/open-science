import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { composeApplicationRuntime } from '../application-runtime'
import { createResearchFilmLifecycle } from '../research-video/lifecycle'
import { composeResearchFilm } from './research-film'

const mocks = vi.hoisted(() => ({
  root: '',
  events: [] as string[],
  run: vi.fn(),
  install: vi.fn(),
  acquire: vi.fn(),
  shutdown: vi.fn()
}))
vi.mock('../storage-root', () => ({ resolveDataRoot: () => mocks.root }))
vi.mock('../runtime-metadata', () => ({ runtimeMetadata: () => ({ version: 'test' }) }))
vi.mock('../local-models/owner', () => ({
  createLocalModelOwner: ({ namespace }: { namespace: string }) => ({
    install: mocks.install,
    acquireUse: mocks.acquire,
    close: async () => {
      mocks.events.push(`close:${namespace}`)
    }
  })
}))
vi.mock('../acp/restricted-inference-runner', () => ({
  RestrictedInferenceRunner: class {
    run = mocks.run
    shutdown = mocks.shutdown
  }
}))

it.each(['running', 'max_tokens', 'refusal', 'empty'] as const)(
  'handles %s generation without publishing incomplete content',
  async (outcome) => {
    vi.clearAllMocks()
    mocks.root = await mkdtemp(join(tmpdir(), 'film-composition-'))
    mocks.events.length = 0
    const request = { projectId: 'p', sessionId: 's' }
    const session = {
      id: 's',
      projectId: 'p',
      title: 'Evidence',
      revision: 1,
      messages: [
        {
          id: 'q',
          role: 'user',
          content: 'Explain the evidence.',
          status: 'complete',
          eventIds: []
        },
        {
          id: 'a',
          role: 'agent',
          content: 'The result is uncertain.',
          status: 'complete',
          eventIds: []
        }
      ]
    }
    const before = structuredClone(session)
    mocks.acquire.mockResolvedValue({
      revision: 'test',
      assets: [{ file: 'model_quantized.onnx', path: join(mocks.root, 'model_quantized.onnx') }],
      release: () => {
        mocks.events.push('release')
      }
    })
    mocks.run.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              mocks.events.push('aborted')
              reject(signal.reason)
            },
            { once: true }
          )
        })
    )
    if (outcome !== 'running')
      mocks.run.mockResolvedValue({
        text: '',
        frameworkId: 'pi',
        model: 'test',
        stopReason: outcome === 'empty' ? 'end_turn' : outcome,
        usage: { inputTokens: 10, outputTokens: 16384 }
      })
    mocks.shutdown.mockImplementation(async () => {
      mocks.events.push('shutdown')
    })
    const input = {
      configRoot: mocks.root,
      settingsService: {
        captureActiveExplicitAgentBackendTarget: vi.fn(async () => ({ providerId: 'test' }))
      },
      sessionRepository: { loadSession: vi.fn(async () => session) },
      sessionPersistenceCoordinator: { runSessionMutation: vi.fn() },
      sessionPackageService: { readResearchFilm: vi.fn() },
      researchFilmLifecycle: createResearchFilmLifecycle({ dataRoot: () => mocks.root }),
      recordAuxiliaryUsage: vi.fn()
    }
    const runtime = await composeApplicationRuntime(async (modules) =>
      composeResearchFilm({
        ...input,
        modules
      } as unknown as Parameters<typeof composeResearchFilm>[0])
    )
    try {
      const owner = runtime.interfaces.researchVideoPresentation
      expect(await owner.status(request)).toEqual({})
      expect(mocks.run).not.toHaveBeenCalled()
      expect(mocks.acquire).not.toHaveBeenCalled()
      expect(mocks.install).not.toHaveBeenCalled()
      expect(await readdir(mocks.root)).toEqual([])
      await owner.start(request)
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce())
      if (outcome !== 'running') {
        await vi.waitFor(async () =>
          expect((await owner.status(request)).progress?.phase).toBe('failed')
        )
        const status = await owner.status(request)
        expect(status.error).toContain(
          outcome === 'max_tokens'
            ? 'output token limit'
            : outcome === 'empty'
              ? 'no research film content'
              : 'refusal'
        )
        expect(status.result).toBeUndefined()
        expect(mocks.run).toHaveBeenCalledOnce()
        expect(input.recordAuxiliaryUsage).toHaveBeenCalledOnce()
        return
      }
      expect((await owner.status(request)).progress?.phase).toBe('writing')
      await runtime.dispose()
      expect(mocks.events).toEqual([
        'aborted',
        'release',
        'shutdown',
        'close:video-export',
        'close:research-narration'
      ])
      expect(session).toEqual(before)
      expect(input.recordAuxiliaryUsage).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
      await rm(mocks.root, { recursive: true, force: true })
    }
  }
)
