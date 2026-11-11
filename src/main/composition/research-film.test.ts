import * as inputContext from '../research-video/input-context'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { composeApplicationRuntime } from '../application-runtime'
import { createResearchFilmLifecycle } from '../research-video/lifecycle'
import { composeResearchFilm } from './research-film'
import { RestrictedInferenceError } from '../acp/restricted-inference-contract'
import { computePreflight } from '../settings/preflight'

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
    getSnapshot: async () => ({ availability: 'notInstalled' }),
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
  'session-missing',
  'session-unreadable',
  'runtime-unavailable',
  'provider-unavailable',
  'provider-missing',
  'model-unavailable',
  'incompatible',
  'input-unavailable',
  'running',
  'unvalidated-interface',
  'max_tokens',
  'max_turn_requests',
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
    if (outcome !== 'running' && outcome !== 'unvalidated-interface')
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
        getPreflight: vi.fn(async () =>
          computePreflight({
            settings: {
              version: 2,
              activeProviderId: outcome === 'provider-missing' ? undefined : 'test',
              providers: [
                {
                  id: 'test',
                  name: 'Test',
                  type: 'custom',
                  lastValidatedAt: 1,
                  lastValidatedTarget: {
                    model: 'test',
                    endpoint: outcome === 'unvalidated-interface' ? 'chat-completions' : 'responses'
                  }
                }
              ]
            },
            agentFrameworkId: 'pi',
            piRuntimeReady: outcome !== 'runtime-unavailable',
            claudePathExists: false,
            opencodePathExists: false,
            codebuddyPathExists: false,
            codexPathExists: false,
            isProviderKeyUsable: () => outcome !== 'provider-unavailable',
            activeProviderCompatible: outcome !== 'incompatible',
            activeProviderModelAvailable: outcome !== 'model-unavailable',
            activeValidationTarget: { model: 'test', endpoint: 'responses' }
          })
        ),
        captureActiveExplicitAgentBackendTarget: vi.fn(async () => ({
          frameworkId: 'pi',
          providerId: 'test',
          model:
            outcome === 'refusal' ? { kind: 'provider-default' } : { kind: 'required', id: 'test' },
          reasoningEffort: 'medium'
        }))
      },
      sessionRepository: {
        loadSessionWithDiagnostics: vi.fn(async () => {
          if (outcome === 'session-missing') return { status: 'missing' as const }
          if (outcome === 'session-unreadable') return { status: 'unreadable' as const }
          return { status: 'found' as const, session }
        })
      },
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
      const initialStatus = await owner.status(request)
      expect(input.sessionRepository.loadSessionWithDiagnostics).toHaveBeenCalledWith('p', 's', {
        mode: 'read-only'
      })
      if (outcome === 'session-missing' || outcome === 'session-unreadable') {
        expect(initialStatus).toEqual({ generationBlock: 'unavailable' })
        expect(mocks.run).not.toHaveBeenCalled()
        expect(await readdir(mocks.root)).toEqual([])
        return
      }
      expect(initialStatus).toEqual({})
      expect(mocks.run).not.toHaveBeenCalled()
      expect(mocks.acquire).not.toHaveBeenCalled()
      expect(mocks.install).not.toHaveBeenCalled()
      expect(await readdir(mocks.root)).toEqual([])
      const preflightErrors: Partial<Record<(typeof outcomes)[number], string>> = {
        'runtime-unavailable': 'agent runtime',
        'provider-unavailable': 'credentials are unavailable',
        'provider-missing': 'Select a model in Settings',
        'model-unavailable': 'selected model is unavailable',
        incompatible: "isn't compatible",
        'input-unavailable': 'input limit'
      }
      if (preflightErrors[outcome]) {
        const preflight = await owner.status({ ...request, checkReadiness: true })
        expect(preflight.preflightError).toContain(preflightErrors[outcome])
        expect((await owner.start(request)).preflightError).toBe(preflight.preflightError)
        expect(mocks.run).not.toHaveBeenCalled()
        expect(mocks.acquire).not.toHaveBeenCalled()
        expect(mocks.install).not.toHaveBeenCalled()
        expect(await readdir(mocks.root)).toEqual([])
        expect(input.recordAuxiliaryUsage).not.toHaveBeenCalled()
        return
      }
      if (outcome === 'unvalidated-interface') {
        expect(await input.settingsService.getPreflight()).toMatchObject({
          activeProviderReady: false,
          providerReadiness: { status: 'not_ready' }
        })
        expect(
          (await owner.status({ ...request, checkReadiness: true })).preflightError
        ).toBeUndefined()
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
      if (outcome !== 'running' && outcome !== 'unvalidated-interface') {
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
                : outcome === 'max_turn_requests'
                  ? 'max_turn_requests'
                  : outcome === 'empty'
                    ? 'no research film content'
                    : 'refusal'
        )
        expect(status.result).toBeUndefined()
        const calls =
          outcome === 'recovered'
            ? 3
            : ['max_tokens', 'max_turn_requests', 'empty', 'output-limit'].includes(outcome)
              ? 2
              : 1
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
          // Failed progress can arrive before file cleanup releases the active job. Retry until
          // a second job is admitted rather than observing the first job's terminal state again.
          await vi.waitFor(async () => {
            await owner.start(request)
            expect(mocks.acquire).toHaveBeenCalledTimes(2)
          })
          await vi.waitFor(async () => {
            expect(
              input.settingsService.captureActiveExplicitAgentBackendTarget
            ).toHaveBeenCalledTimes(2)
            expect((await owner.status(request)).progress?.phase).toBe('failed')
          })
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
