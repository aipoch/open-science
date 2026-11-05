import * as inputContext from '../research-video/input-context'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { composeApplicationRuntime } from '../application-runtime'
import { createResearchFilmLifecycle } from '../research-video/lifecycle'
import { composeResearchFilm } from './research-film'
import { RestrictedInferenceError } from '../acp/restricted-inference-contract'

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
vi.mock('../acp/restricted-inference-runner', async () => ({
  ...(await import('../acp/restricted-inference-contract')),
  RestrictedInferenceRunner: class {
    run = mocks.run
    shutdown = mocks.shutdown
  }
}))

const outcomes = [
  'runtime-unavailable',
  'provider-unavailable',
  'input-unavailable',
  'running',
  'max_tokens',
  'output-limit',
  'transport',
  'recovered',
  'refusal',
  'empty'
] as const

it.each(outcomes)(
  'handles %s generation without publishing incomplete content',
  async (outcome) => {
    vi.clearAllMocks()
    const counter = vi.spyOn(inputContext, 'researchFilmTokenCounter')
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
    if (outcome === 'output-limit')
      mocks.run.mockRejectedValue(
        new RestrictedInferenceError('output-limit', 'byte output limit', {
          inputTokens: 10,
          outputTokens: 16384,
          cacheTokens: 0
        })
      )
    if (outcome === 'transport')
      mocks.run.mockRejectedValue(
        new RestrictedInferenceError('transport-unavailable', 'transport unavailable', {
          inputTokens: 10,
          outputTokens: 20,
          cacheTokens: 0
        })
      )
    if (outcome === 'recovered') {
      const result = {
        frameworkId: 'pi',
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 20 }
      }
      mocks.run
        .mockResolvedValueOnce({ ...result, text: '{', stopReason: 'max_tokens' })
        .mockResolvedValueOnce({
          ...result,
          stopReason: 'end_turn',
          text: JSON.stringify({
            version: 1,
            case: 'evidence',
            title: 'Evidence',
            session: 'session.json',
            scenes: [
              {
                id: 'hook',
                role: 'hook',
                msg: 1,
                lines: [{ caption: 'The result is uncertain.' }],
                panels: [
                  { type: 'title', text: 'Evidence' },
                  { type: 'animation', script: 'anims/hook.js', size: 'band' }
                ]
              }
            ]
          })
        })
        .mockResolvedValue({ ...result, text: '', stopReason: 'refusal' })
    }
    mocks.shutdown.mockImplementation(async () => {
      mocks.events.push('shutdown')
    })
    const input = {
      configRoot: mocks.root,
      settingsService: {
        getSettingsView: vi.fn(async () => ({
          activeProviderId: 'test',
          agentFrameworkId: 'pi',
          activeModel: outcome === 'refusal' ? undefined : 'test',
          providers: [
            {
              id: 'test',
              type: 'custom',
              model: outcome === 'refusal' ? 'claude-test' : 'test',
              contextWindow: outcome === 'input-unavailable' ? 9000 : 200_000
            }
          ]
        })),
        getPreflight: vi.fn(async () => ({
          agentReady: outcome !== 'runtime-unavailable',
          activeProviderReady: outcome !== 'provider-unavailable'
        })),
        captureActiveExplicitAgentBackendTarget: vi.fn(async () => ({
          frameworkId: 'pi',
          providerId: 'test',
          model:
            outcome === 'refusal' ? { kind: 'provider-default' } : { kind: 'required', id: 'test' },
          reasoningEffort: 'medium'
        }))
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
      if (
        outcome === 'runtime-unavailable' ||
        outcome === 'provider-unavailable' ||
        outcome === 'input-unavailable'
      ) {
        const preflight = await owner.status({ ...request, checkReadiness: true })
        expect(preflight.preflightError).toContain(
          outcome === 'runtime-unavailable'
            ? 'agent runtime'
            : outcome === 'input-unavailable'
              ? 'input limit'
              : 'model and credentials'
        )
        expect((await owner.start(request)).preflightError).toBe(preflight.preflightError)
        expect(mocks.run).not.toHaveBeenCalled()
        expect(mocks.acquire).not.toHaveBeenCalled()
        expect(mocks.install).not.toHaveBeenCalled()
        expect(await readdir(mocks.root)).toEqual([])
        expect(input.recordAuxiliaryUsage).not.toHaveBeenCalled()
        return
      }
      await owner.start(request)
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled())
      if (outcome === 'refusal') {
        expect(counter).toHaveBeenLastCalledWith(
          expect.objectContaining({
            frameworkId: 'pi',
            model: { kind: 'required', id: 'claude-test' }
          })
        )
        expect(mocks.run.mock.calls[0][0].target.model).toEqual({ kind: 'provider-default' })
      }
      if (outcome !== 'running') {
        await vi.waitFor(async () =>
          expect((await owner.status(request)).progress?.phase).toBe('failed')
        )
        const status = await owner.status(request)
        expect(status.error).toContain(
          outcome === 'transport'
            ? 'transport unavailable'
            : outcome === 'output-limit'
              ? 'byte output limit'
              : outcome === 'max_tokens'
                ? 'output token limit'
                : outcome === 'empty'
                  ? 'no research film content'
                  : 'refusal'
        )
        expect(status.result).toBeUndefined()
        const calls =
          outcome === 'recovered' ? 3 : ['max_tokens', 'output-limit'].includes(outcome) ? 2 : 1
        expect(mocks.run).toHaveBeenCalledTimes(calls)
        expect(input.recordAuxiliaryUsage).toHaveBeenCalledTimes(calls)
        expect(input.settingsService.captureActiveExplicitAgentBackendTarget).toHaveBeenCalledOnce()
        expect(input.settingsService.getSettingsView).toHaveBeenCalledTimes(2)
        expect(new Set(mocks.run.mock.calls.map(([request]) => request.target)).size).toBe(1)
        if (calls > 1) {
          const correction = JSON.parse(mocks.run.mock.calls[1][0].prompt).correction
          expect(correction).toMatchObject({ draft: '', error: expect.stringContaining('shorter') })
        }
        if (outcome === 'recovered') {
          expect(mocks.run.mock.calls[2][0].systemPrompt).toContain('JavaScript animation')
          await owner.start(request)
          await vi.waitFor(async () =>
            expect((await owner.status(request)).progress?.phase).toBe('failed')
          )
          expect(
            input.settingsService.captureActiveExplicitAgentBackendTarget
          ).toHaveBeenCalledTimes(2)
        }
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
      counter.mockRestore()
      await runtime.dispose()
      await rm(mocks.root, { recursive: true, force: true })
    }
  }
)
