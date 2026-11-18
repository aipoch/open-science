import * as inputContext from '../research-video/input-context'
import * as presentation from '../research-video/presentation'
import type { ResearchVideoSessionSource } from '@aipoch/research-film'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { composeApplicationRuntime } from '../application-runtime'
import { createResearchFilmLifecycle } from '../research-video/lifecycle'
import { composeResearchFilm } from './research-film'
import { RestrictedInferenceError } from '../acp/restricted-inference-contract'
import { computePreflight } from '../settings/preflight'
import { RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE } from '../../shared/research-video-presentation'

const mocks = vi.hoisted(() => ({
  root: '',
  events: [] as string[],
  run: vi.fn(),
  install: vi.fn(),
  acquire: vi.fn(),
  shutdown: vi.fn(),
  sweep: vi.fn(async () => {}),
  log: vi.fn(),
  delay: vi.fn(),
  runnerOptions: vi.fn()
}))
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: (...args: unknown[]) => mocks.delay(...args)
}))
vi.mock('@aipoch/diagnostics/node', async (original) => ({
  ...(await original<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => ({ info: mocks.log })
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
    constructor(options: unknown) {
      mocks.runnerOptions(options)
    }
    run = mocks.run
    shutdown = mocks.shutdown
    sweepStaleProfiles = mocks.sweep
  }
}))

const outcomes = [
  'prompt-unavailable',
  'target-unavailable',
  'target-stalled',
  'target-timeout',
  'model-timeout',
  'model-cancelled',
  'model-failure-after-deadline',
  'usage-stalled',
  'usage-timeout',
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
  'transport',
  'recovered',
  'refusal',
  'empty'
] as const

it.each(outcomes)(
  'handles %s generation without publishing incomplete content',
  async (outcome) => {
    vi.clearAllMocks()
    mocks.delay.mockResolvedValue(undefined)
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
        stopReason:
          outcome === 'empty' ? 'end_turn' : outcome === 'usage-stalled' ? 'refusal' : outcome,
        usage: { inputTokens: 10, outputTokens: 16384 }
      })
    if (outcome === 'transport')
      mocks.run.mockRejectedValue(
        new RestrictedInferenceError('transport-unavailable', 'transport unavailable', {
          inputTokens: 10,
          outputTokens: 20,
          cacheTokens: 0
        })
      )
    if (outcome === 'recovered' || outcome === 'usage-timeout') {
      const result = {
        frameworkId: 'pi',
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 20 }
      }
      if (outcome === 'recovered')
        mocks.run.mockResolvedValueOnce({ ...result, text: '{', stopReason: 'max_tokens' })
      mocks.run.mockResolvedValueOnce({
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
            },
            {
              id: 'outro',
              role: 'outro',
              msg: 1,
              lines: [
                { caption: 'The result remains uncertain.' },
                {
                  caption:
                    'AIPOCH Open-Science — the AI research workbench for reproducible science.'
                }
              ],
              panels: [{ type: 'end_card', at: '1' }]
            }
          ]
        })
      })
      if (outcome === 'recovered')
        mocks.run.mockResolvedValueOnce({
          ...result,
          stopReason: 'end_turn',
          text: JSON.stringify({
            spine: null,
            catch: null,
            thread: null,
            audioOnly: null,
            numbers: null,
            plainWords: null,
            lineCraft: null,
            clean: null,
            true: null
          })
        })
      if (outcome === 'recovered')
        mocks.run.mockResolvedValueOnce({
          ...result,
          text: 'function draw(',
          stopReason: 'max_tokens'
        })
      mocks.run.mockResolvedValue({ ...result, text: '', stopReason: 'refusal' })
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
              contextWindow: outcome === 'input-unavailable' ? 9000 : 200_000,
              ...(outcome === 'recovered' ? { maxOutputTokens: 200_000 } : {})
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
      if (outcome === 'running') expect(mocks.sweep).toHaveBeenCalledOnce()
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
      if (outcome === 'recovered')
        expect(
          (await owner.status({ ...request, checkReadiness: true })).preflightError
        ).toBeUndefined()
      if (outcome === 'target-unavailable') {
        input.settingsService.captureActiveExplicitAgentBackendTarget.mockRejectedValueOnce(
          new Error('private target failure')
        )
        await owner.start(request)
        await vi.waitFor(() =>
          expect(mocks.log).toHaveBeenCalledWith(
            'film model target failed',
            expect.objectContaining({
              sessionId: 's',
              invocationId: expect.any(String),
              errorCategory: 'error'
            })
          )
        )
        expect(mocks.run).not.toHaveBeenCalled()
        expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('private target failure')
        return
      }
      if (
        outcome === 'model-timeout' ||
        outcome === 'model-cancelled' ||
        outcome === 'model-failure-after-deadline'
      ) {
        const deadline = new AbortController()
        const realTimeout = AbortSignal.timeout
        const timeout = vi
          .spyOn(AbortSignal, 'timeout')
          .mockImplementation((ms) => (ms === 300_000 ? deadline.signal : realTimeout(ms)))
        mocks.run.mockImplementation(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_, reject) => {
              if (signal.aborted) {
                reject(
                  new RestrictedInferenceError('cancelled', 'Restricted inference was cancelled.')
                )
                return
              }
              signal.addEventListener(
                'abort',
                () =>
                  reject(
                    outcome === 'model-failure-after-deadline'
                      ? new RestrictedInferenceError(
                          'transport-unavailable',
                          'Transport failed before cleanup.'
                        )
                      : new RestrictedInferenceError(
                          'cancelled',
                          'Restricted inference was cancelled.'
                        )
                  ),
                { once: true }
              )
            })
        )
        try {
          await owner.start(request)
          await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce())
          if (outcome !== 'model-cancelled')
            deadline.abort(new DOMException('Timed out', 'TimeoutError'))
          else owner.cancel(request)
          await vi.waitFor(async () => {
            const status = await owner.status(request)
            expect(status.progress?.phase).toBe(
              outcome !== 'model-cancelled' ? 'failed' : 'cancelled'
            )
            expect(status.error).toBe(
              outcome === 'model-timeout'
                ? RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE
                : outcome === 'model-failure-after-deadline'
                  ? 'Transport failed before cleanup.'
                  : undefined
            )
          })
          expect(mocks.log).toHaveBeenCalledWith(
            'film model failure',
            expect.objectContaining({
              errorCategory:
                outcome === 'model-timeout'
                  ? 'timeout'
                  : outcome === 'model-failure-after-deadline'
                    ? 'transport-unavailable'
                    : 'cancelled'
            })
          )
          expect(mocks.run).toHaveBeenCalledTimes(outcome === 'model-timeout' ? 2 : 1)
          expect(mocks.delay).toHaveBeenCalledTimes(outcome === 'model-timeout' ? 1 : 0)
        } finally {
          timeout.mockRestore()
        }
        return
      }
      if (
        outcome === 'target-stalled' ||
        outcome === 'target-timeout' ||
        outcome === 'usage-stalled' ||
        outcome === 'usage-timeout'
      ) {
        const target = outcome.startsWith('target-')
        const expires = outcome.endsWith('-timeout')
        const stalled = Promise.withResolvers<never>()
        const entered = vi.fn()
        const wait = (): Promise<never> => {
          entered()
          return stalled.promise
        }
        if (target)
          input.settingsService.captureActiveExplicitAgentBackendTarget.mockImplementationOnce(wait)
        else input.recordAuxiliaryUsage.mockImplementationOnce(wait)
        const deadline = new AbortController()
        const realTimeout = AbortSignal.timeout
        const timeout = expires
          ? vi
              .spyOn(AbortSignal, 'timeout')
              .mockImplementation((ms) =>
                ms === (target ? 30_000 : 5_000) ? deadline.signal : realTimeout(ms)
              )
          : undefined
        try {
          await owner.start(request)
          await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
          if (expires) deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'))
          else owner.cancel(request)
          await vi.waitFor(async () =>
            expect(await owner.status(request)).toMatchObject({
              progress: { phase: expires ? 'failed' : 'cancelled' },
              ...(expires
                ? { error: expect.stringContaining(target ? 'model setup timed out' : 'refusal') }
                : {})
            })
          )
          expect(mocks.run).toHaveBeenCalledTimes(target ? 0 : expires ? 2 : 1)
          if (!target && expires) {
            const review = JSON.parse(mocks.run.mock.calls[1][0].prompt)
            expect(review.narration[0].id).toBe('hook')
          }
        } finally {
          timeout?.mockRestore()
          stalled.reject(new Error('Delayed operation failed'))
        }
        return
      }
      const prepare =
        outcome === 'prompt-unavailable'
          ? vi.spyOn(inputContext, 'prepareResearchFilmPrompt').mockImplementation(() => {
              throw new Error('private prompt failure')
            })
          : undefined
      try {
        await owner.start(request)
        if (prepare) {
          await vi.waitFor(() =>
            expect(mocks.log).toHaveBeenCalledWith(
              'film model failure',
              expect.objectContaining({
                sessionId: 's',
                requestId: expect.any(String),
                errorCategory: 'inference'
              })
            )
          )
          expect(mocks.run).not.toHaveBeenCalled()
          expect(input.recordAuxiliaryUsage).not.toHaveBeenCalled()
          expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('private prompt failure')
          return
        }
      } finally {
        prepare?.mockRestore()
      }
      // Filesystem staging can exceed the default one-second wait on a busy runner.
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled(), { timeout: 5_000 })
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
            ? 5
            : ['max_tokens', 'max_turn_requests', 'empty'].includes(outcome)
              ? 2
              : 1
        expect(mocks.run).toHaveBeenCalledTimes(calls)
        expect(input.recordAuxiliaryUsage).toHaveBeenCalledTimes(calls)
        expect(input.settingsService.captureActiveExplicitAgentBackendTarget).toHaveBeenCalledOnce()
        expect(input.settingsService.getSettingsView).toHaveBeenCalledTimes(
          outcome === 'recovered' ? 3 : 2
        )
        expect(new Set(mocks.run.mock.calls.map(([request]) => request.target)).size).toBe(1)
        if (calls > 1) {
          const correction = JSON.parse(mocks.run.mock.calls[1][0].prompt).correction
          expect(correction).toMatchObject({
            draft: '',
            error: expect.stringContaining('complete replacement')
          })
        }
        if (outcome === 'recovered') {
          for (const [call] of mocks.run.mock.calls) {
            expect(call.outputLimitBytes).toBeUndefined()
            expect(call.systemPrompt).not.toMatch(/at most \d+ (?:visible|output) tokens/)
          }
          const animationCorrection = JSON.parse(mocks.run.mock.calls[4][0].prompt)
          expect(animationCorrection).toMatchObject({
            path: 'anims/hook.js',
            correction: { draft: '' }
          })
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
      // Start inference shutdown before waiting for Film cleanup, which can stall on I/O.
      expect(mocks.events).toEqual([
        'aborted',
        'shutdown',
        'release',
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

it.each([
  'network',
  'provider-cancelled',
  'provider-interrupted',
  'deadline',
  'local-limit',
  'shared-limit',
  'cancel-wait',
  'permanent'
] as const)('bounds automatic model retries: %s', async (scenario) => {
  mocks.run.mockReset()
  mocks.delay.mockReset().mockResolvedValue(undefined)
  mocks.log.mockClear()
  mocks.root = await mkdtemp(join(tmpdir(), 'film-retry-'))
  const source: ResearchVideoSessionSource = {
    sessionTitle: 'Evidence',
    project: 'Research',
    messages: [],
    provenance: { projectId: 'p', sessionId: 's', sourceClaimsIndependentlyVerified: false }
  }
  let author!: Parameters<typeof presentation.createResearchVideoPresentationOwner>[0]
  const createOwner = presentation.createResearchVideoPresentationOwner
  const ownerSpy = vi
    .spyOn(presentation, 'createResearchVideoPresentationOwner')
    .mockImplementation((options) => {
      author = options
      return createOwner(options)
    })
  const target = { frameworkId: 'pi', providerId: 'test', model: { kind: 'required', id: 'test' } }
  const capture = vi.fn(async () => target)
  const usage = { inputTokens: 10, outputTokens: 20, cacheTokens: 0 }
  const recordUsage = vi.fn()
  const response = {
    text: 'complete',
    frameworkId: 'pi',
    model: 'test',
    stopReason: 'end_turn',
    usage
  }
  const networkFailure = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET', usage })
  const controller = new AbortController()
  const runtime = await composeApplicationRuntime(async (modules) =>
    composeResearchFilm({
      configRoot: mocks.root,
      modules,
      settingsService: {
        captureActiveExplicitAgentBackendTarget: capture,
        getSettingsView: async () => ({
          providers: [{ id: 'test', model: 'test', contextWindow: 200_000 }]
        })
      },
      recordAuxiliaryUsage: recordUsage
    } as unknown as Parameters<typeof composeResearchFilm>[0])
  )
  const deadline = new AbortController()
  const realTimeout = AbortSignal.timeout
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) =>
      scenario === 'deadline' && ms === 300_000 && mocks.run.mock.calls.length === 0
        ? deadline.signal
        : realTimeout(ms)
    )
  try {
    expect(mocks.runnerOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ requireConfirmedCleanup: true })
    )
    mocks.run.mockResolvedValue(response)
    if (scenario === 'provider-cancelled')
      mocks.run.mockResolvedValueOnce({ ...response, text: '', stopReason: 'cancelled' })
    else if (scenario === 'provider-interrupted')
      mocks.run.mockRejectedValueOnce(
        new RestrictedInferenceError('cancelled', 'Interrupted', usage)
      )
    else if (scenario === 'deadline')
      mocks.run.mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new RestrictedInferenceError('cancelled', 'Cancelled', usage)),
              { once: true }
            )
          })
      )
    else if (scenario === 'permanent')
      mocks.run.mockRejectedValue(
        new RestrictedInferenceError('tool-violation', 'Tools are prohibited')
      )
    else if (scenario === 'local-limit' || scenario === 'shared-limit')
      mocks.run.mockRejectedValue(networkFailure)
    else
      mocks.run.mockRejectedValueOnce(
        Object.assign(new Error('Fetch failed', { cause: networkFailure }), { usage })
      )

    if (scenario === 'cancel-wait') {
      mocks.delay.mockImplementation(
        (_ms, _value, { signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      )
    }
    // Exercise the public author callback wired by composition, leaving filesystem publication
    // and output correction to their existing owner/engine suites.
    const write = (): Promise<string> => author.writeReplay!(source, controller.signal)
    if (scenario === 'shared-limit') {
      // Two concurrent units exhaust the shared allowance. A later correction gets no new budget.
      await Promise.all([
        expect(write()).rejects.toBe(networkFailure),
        expect(write()).rejects.toBe(networkFailure)
      ])
      expect(mocks.run).toHaveBeenCalledTimes(4)
      await expect(write()).rejects.toBe(networkFailure)
      expect(mocks.run).toHaveBeenCalledTimes(5)
      expect(mocks.delay).toHaveBeenCalledTimes(2)
      // A new generation uses a new frozen source and receives a fresh allowance.
      await expect(author.writeReplay!({ ...source }, controller.signal)).rejects.toBe(
        networkFailure
      )
      expect(mocks.run).toHaveBeenCalledTimes(7)
      expect(mocks.delay).toHaveBeenCalledTimes(3)
      return
    }
    if (scenario === 'local-limit' || scenario === 'permanent') {
      await expect(write()).rejects.toThrow(
        scenario === 'permanent' ? 'Tools are prohibited' : 'Connection reset'
      )
      expect(mocks.run).toHaveBeenCalledTimes(scenario === 'permanent' ? 1 : 2)
      expect(mocks.delay).toHaveBeenCalledTimes(scenario === 'permanent' ? 0 : 1)
      return
    }
    const pending = write()
    if (scenario === 'deadline') {
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce())
      deadline.abort(new DOMException('Timed out', 'TimeoutError'))
    }
    if (scenario === 'cancel-wait') {
      const settled = expect(pending).rejects.toThrow('User stopped the film')
      await vi.waitFor(() => expect(mocks.delay).toHaveBeenCalledOnce())
      controller.abort(new Error('User stopped the film'))
      await settled
      expect(mocks.run).toHaveBeenCalledOnce()
      return
    }
    await expect(pending).resolves.toBe('complete')
    expect(mocks.delay).toHaveBeenCalledOnce()
    expect(mocks.delay.mock.calls[0][0]).toBeGreaterThanOrEqual(10_000)
    expect(mocks.delay.mock.calls[0][0]).toBeLessThanOrEqual(12_000)
    expect(mocks.run).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.run.mock.calls.map(([request]) => request)
    expect(second).toMatchObject({
      prompt: first.prompt,
      systemPrompt: first.systemPrompt,
      target: first.target
    })
    expect(second.signal).not.toBe(first.signal)
    expect(capture).toHaveBeenCalledOnce()
    expect(recordUsage).toHaveBeenCalledTimes(2)
    expect(new Set(recordUsage.mock.calls.map(([record]) => record.eventId)).size).toBe(2)
  } finally {
    controller.abort()
    timeout.mockRestore()
    ownerSpy.mockRestore()
    mocks.delay.mockReset()
    await runtime.dispose()
    await rm(mocks.root, { recursive: true, force: true })
  }
})
