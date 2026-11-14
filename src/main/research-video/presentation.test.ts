import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  parseResearchVideoScreenplay,
  ResearchVideoSpeechCleanupError
} from '@aipoch/research-film'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { filmAuthoringCheckpoint, PENDING_FILM_OWNER } from './checkpoint'
import { createResearchVideoPresentationOwner } from './presentation'
import { researchVideoSessionSource, researchVideoGenerationBlock } from './session-source'
import { researchFilmScopeKey } from './stored-presentation'

const { timing } = vi.hoisted(() => ({ timing: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', async (original) => ({
  ...(await original<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => ({ info: timing })
}))

vi.mock('@aipoch/durable-files', async (original) => {
  const actual = await original<typeof import('@aipoch/durable-files')>()
  return { ...actual, writeDurableJsonFile: vi.fn(actual.writeDurableJsonFile) }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const request = { projectId: 'project', sessionId: 'session' }
const session = {
  id: 'session',
  projectId: 'project',
  title: 'Rainfall',
  revision: 4,
  messages: [
    { id: 'question', role: 'user', content: 'Study rainfall.', status: 'complete', eventIds: [] },
    {
      id: 'result',
      role: 'agent',
      content: 'The observed trend was uncertain.',
      status: 'complete',
      eventIds: []
    }
  ],
  packageOrigin: { imported: true }
} as unknown as PersistedChatSession
const script = JSON.stringify({
  title: 'Rainfall uncertainty',
  scenes: [
    {
      msg: 1,
      lines: [{ caption: 'The observed trend was uncertain.' }],
      panels: [
        { type: 'title', text: 'Uncertain trend' },
        {
          type: 'illustration',
          description: 'An uncertain trend',
          elements: [{ kind: 'line', x: 100, y: 100, x2: 500, y2: 100, motion: 'draw' }]
        }
      ]
    }
  ]
})
type Options = Parameters<typeof createResearchVideoPresentationOwner>[0]
async function fixture(): Promise<{
  options: Options & {
    writeScreenplay: Mock<Options['writeScreenplay']>
    generate: Mock<Options['generate']>
  }
  release: Mock<() => void>
  setRoot(next: string): void
}> {
  let root = await mkdtemp(join(tmpdir(), 'research-presentation-'))
  roots.push(root)
  const release = vi.fn()
  const models = {
    getSnapshot: vi.fn(async () => ({ availability: 'notInstalled' })),
    acquireUse: vi.fn(async () => ({
      release,
      revision: 'model',
      assets: [{ file: 'model_quantized.onnx', path: join(root, 'model_quantized.onnx') }]
    }))
  } as unknown as Options['models']
  const loadSession = vi.fn(async () => session)
  const writeScreenplay = vi.fn(
    async (
      _source: ReturnType<typeof researchVideoSessionSource>,
      _signal: AbortSignal
    ): Promise<string> => {
      void _source
      void _signal
      return script
    }
  )
  const generate = vi.fn<Options['generate']>(async (input) => {
    await mkdir(input.outputDirectory)
    const playerPath = join(input.outputDirectory, 'player.html'),
      sourcePath = join(input.outputDirectory, 'sources.zip')
    await writeFile(playerPath, '<html>Generated</html>')
    await writeFile(sourcePath, 'source')
    return { playerPath, sourcePath, duration: 4.85, preparationMs: 10 }
  })
  const options = {
    dataRoot: () => root,
    models,
    loadSession,
    writeScreenplay,
    generate,
    engineDirectory: root
  }
  return {
    options,
    release,
    setRoot: (next: string) => {
      root = next
      roots.push(next)
    }
  }
}
it('generates a persistent presentation directly from read-only history without changing it', async () => {
  const f = await fixture(),
    owner = createResearchVideoPresentationOwner(f.options)
  timing.mockClear()
  const before = JSON.stringify(session)
  expect(await owner.status(request)).toEqual({})
  expect(f.options.writeScreenplay).not.toHaveBeenCalled()
  await owner.start(request)
  await owner.start(request)
  await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
  const result = (await owner.status(request)).result!
  expect(await readFile(result.playerPath, 'utf8')).toContain('Generated')
  expect(f.options.writeScreenplay.mock.calls[0][0].messages).toEqual([
    expect.objectContaining({ i: 0, id: 'question', role: 'user' }),
    expect.objectContaining({
      id: 'result',
      role: 'agent',
      md: 'The observed trend was uncertain.'
    })
  ])
  expect(f.options.writeScreenplay).toHaveBeenCalledTimes(1)
  expect(f.options.generate).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(session)).toBe(before)
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  expect(timing).toHaveBeenCalledWith('generation timing', {
    invocationId: expect.any(String),
    operationId: result!.id,
    attempt: 1,
    sessionId: request.sessionId,
    activeBranchId: undefined,
    outcome: 'completed',
    totalMs: expect.any(Number),
    stagesMs: {
      preparing: expect.any(Number),
      images: expect.any(Number),
      readiness: expect.any(Number),
      'narration-acquire': expect.any(Number),
      writing: expect.any(Number),
      animations: expect.any(Number),
      loading: expect.any(Number),
      publishing: expect.any(Number)
    }
  })
  expect(JSON.stringify(timing.mock.calls)).not.toContain('Rainfall')
  await owner.close()
  const reopened = createResearchVideoPresentationOwner(f.options)
  expect((await reopened.status(request)).result).toEqual(result)
  expect(await reopened.status({ ...request, sessionId: 'other' })).toEqual({
    generationBlock: 'unavailable'
  })
  const moved = f.options.dataRoot() + '-moved'
  await rename(f.options.dataRoot(), moved)
  f.setRoot(moved)
  expect((await reopened.status(request)).result?.playerPath).toContain(moved)
  await reopened.close()
})
it('continues exactly once for the requesting session when narration finishes in the background', async () => {
  const f = await fixture()
  const download = Promise.withResolvers<Awaited<ReturnType<Options['models']['installForUse']>>>()
  f.options.models.installForUse = vi.fn(() => download.promise)
  const owner = createResearchVideoPresentationOwner(f.options)
  const start = { ...request, installNarration: true }
  expect((await owner.start(start)).narrationDownload).toBeDefined()
  expect((await owner.start(start)).narrationDownload).toBeDefined()
  const other = { ...request, sessionId: 'other' }
  expect((await owner.status(other)).narrationDownload).toBeUndefined()
  owner.cancel(other)
  expect(f.options.writeScreenplay).not.toHaveBeenCalled()
  download.resolve({ ...(await f.options.models.getSnapshot()), availability: 'ready' })
  await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
  expect(f.options.models.installForUse).toHaveBeenCalledOnce()
  expect(f.options.writeScreenplay).toHaveBeenCalledOnce()
  await owner.close()
})
it('cancels the background authoring operation and releases the model lease', async () => {
  const f = await fixture()
  f.options.writeScreenplay.mockImplementation(
    (_source, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  const owner = createResearchVideoPresentationOwner(f.options)
  await owner.start(request)
  await vi.waitFor(() => expect(f.options.writeScreenplay).toHaveBeenCalled())
  owner.cancel({ ...request, sessionId: 'other' })
  expect((await owner.status(request)).progress?.phase).toBe('writing')
  owner.cancel(request)
  await vi.waitFor(async () =>
    expect((await owner.status(request)).progress?.phase).toBe('cancelled')
  )
  await owner.close()
  const progress = (await owner.status(request)).progress!
  expect(progress.endedAt).toBeGreaterThanOrEqual(progress.startedAt)
  expect((await owner.status(request)).progress?.endedAt).toBe(progress.endedAt)
  expect(f.options.generate).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
})
it('preserves Film recovery and its model lease when narration shutdown is unconfirmed', async () => {
  const f = await fixture()
  const exited = Promise.withResolvers<void>()
  const cleanup = new ResearchVideoSpeechCleanupError(exited.promise)
  const entered = Promise.withResolvers<void>()
  f.options.generate.mockImplementation((_input, signal) => {
    entered.resolve()
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(cleanup), { once: true })
    })
  })
  const owner = createResearchVideoPresentationOwner(f.options)
  try {
    await owner.start(request)
    await entered.promise
    owner.cancel(request)
    await vi.waitFor(async () => {
      expect(await owner.status(request)).toMatchObject({
        progress: { phase: 'failed' },
        error: cleanup.message,
        canResume: true
      })
    })
    expect(f.release).not.toHaveBeenCalled()
    exited.resolve()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  } finally {
    exited.resolve()
    await owner.close()
  }
})

it('fails closed on missing source messages or model-authored code and unsupported panels', () => {
  expect(() => parseResearchVideoScreenplay(script, 1)).toThrow('missing source message')
  expect(() =>
    parseResearchVideoScreenplay(script.replace('"title","text"', '"animation","script"'), 2)
  ).toThrow()
  expect(() => researchVideoSessionSource(session, { ...request, branchId: 'missing' })).toThrow(
    'branch'
  )
  expect(() => researchVideoSessionSource({ ...session, messages: [] }, request)).toThrow(
    'no research content'
  )
})
it('snapshots only the requested conversation branch', () => {
  const graph = {
    rootFrameId: 'frame',
    activeFrameId: 'frame',
    frames: [{ id: 'frame', activeBranchId: 'current' }],
    branches: [
      { id: 'current', agentFrameId: 'frame', headMessageId: 'a' },
      { id: 'other', agentFrameId: 'frame', headMessageId: 'b' }
    ],
    messages: [
      { ...session.messages[0], id: 'a', agentFrameId: 'frame' },
      { ...session.messages[1], id: 'b', agentFrameId: 'frame' }
    ]
  } as NonNullable<PersistedChatSession['conversationGraph']>
  const source = researchVideoSessionSource(
    { ...session, conversationGraph: graph },
    { ...request, branchId: 'other' }
  )
  expect(source.messages.map((message) => message.id)).toEqual(['b'])
})

it('corrects malformed screenplay output once against the same frozen source', async () => {
  const f = await fixture()
  f.options.writeScreenplay.mockResolvedValueOnce('{broken').mockResolvedValueOnce(script)
  const owner = createResearchVideoPresentationOwner(f.options)
  await owner.start(request)
  await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
  expect(f.options.writeScreenplay).toHaveBeenCalledTimes(2)
  const [source, signal, correction] = f.options.writeScreenplay.mock.calls[1]
  expect(source).toBe(f.options.writeScreenplay.mock.calls[0][0])
  expect(signal.aborted).toBe(false)
  expect(correction).toMatchObject({ draft: '{broken', error: expect.any(String) })
  expect(f.options.generate).toHaveBeenCalledOnce()
  await owner.close()
})

it('resumes an interrupted scene after restart using the validated screenplay and helper', async () => {
  const f = await fixture()
  f.options.writeScreenplay.mockResolvedValue(
    JSON.stringify({
      version: 1,
      case: 'rainfall',
      title: 'Rainfall uncertainty',
      session: 'session.json',
      scenes: [
        {
          id: 'hook',
          role: 'hook',
          msg: 1,
          lines: [{ caption: 'Is this trend certain?' }],
          panels: [
            { type: 'title', text: 'Is this trend certain?' },
            {
              type: 'animation',
              script: 'anims/hook.js',
              use: ['anims/rain.js'],
              size: 'band',
              box: 'plain'
            }
          ]
        }
      ]
    })
  )
  let interrupted = false
  const writeAnimation = vi.fn<NonNullable<Options['writeAnimation']>>(async (_source, input) => {
    if (input.shared) return 'function rain(k) { k.ctx.fillRect(0, 0, 20, 20); }'
    if (!interrupted) {
      interrupted = true
      throw new Error('Temporary model failure')
    }
    return 'rain(k);'
  })
  const generate = f.options.generate.getMockImplementation()!
  f.options.generate.mockImplementation(async (...args) => {
    await expect(
      readFile(join(dirname(args[0].specPath), PENDING_FILM_OWNER))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
    const spec = JSON.parse(await readFile(args[0].specPath, 'utf8'))
    expect(spec.scenes[0].panels[1].script).toBe('anims/hook.js')
    expect(await readFile(join(args[0].specPath, '..', 'anims/hook.js'), 'utf8')).toBe('rain(k);')
    expect(writeAnimation.mock.calls.map(([, input]) => input.shared)).toEqual([true, false, false])
    return generate(...args)
  })
  const first = createResearchVideoPresentationOwner({ ...f.options, writeAnimation })
  await first.start(request)
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  await first.close()
  const base = join(
    f.options.dataRoot(),
    'research-video-presentations',
    researchFilmScopeKey(request)
  )
  const ownerPath = join(base, 'pending', PENDING_FILM_OWNER)
  const { id } = JSON.parse(await readFile(join(base, 'pending.json'), 'utf8'))
  expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual({ version: 1, id, ...request })
  // Simulate a checkpoint from before ownership receipts were introduced.
  await rm(ownerPath)
  const owner = createResearchVideoPresentationOwner({ ...f.options, writeAnimation })
  try {
    expect(await owner.status(request)).toMatchObject({
      canResume: true,
      filmStep: 3,
      progress: { completed: 1, total: 2 }
    })
    await owner.start({ ...request, resume: true })
    await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
    expect(f.options.generate).toHaveBeenCalledOnce()
    expect(f.options.writeScreenplay).toHaveBeenCalledOnce()
  } finally {
    await owner.close()
  }
})

it('stops after one failed correction without generating or publishing invalid content', async () => {
  const f = await fixture()
  f.options.writeScreenplay.mockResolvedValue(script.replace('"msg":1', '"msg":99'))
  const owner = createResearchVideoPresentationOwner(f.options)
  await owner.start(request)
  await vi.waitFor(async () =>
    expect((await owner.status(request)).error).toContain('missing source message')
  )
  const progress = (await owner.status(request)).progress!
  expect(progress.endedAt).toBeGreaterThanOrEqual(progress.startedAt)
  expect((await owner.status(request)).progress?.endedAt).toBe(progress.endedAt)
  expect(f.options.writeScreenplay).toHaveBeenCalledTimes(2)
  expect(f.options.generate).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  await owner.close()
})

it('keeps the saved player available while regenerating and after a failed replacement', async () => {
  const f = await fixture()
  const owner = createResearchVideoPresentationOwner(f.options)
  await owner.start(request)
  await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  const saved = (await owner.status(request)).result
  let fail: (error: Error) => void = () => {}
  f.options.writeScreenplay.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  )
  await owner.start(request)
  await vi.waitFor(() => expect(f.options.writeScreenplay).toHaveBeenCalledTimes(2))
  expect(await owner.status(request)).toMatchObject({
    result: saved,
    progress: { phase: 'writing' }
  })
  fail(new Error('Replacement failed'))
  await vi.waitFor(async () =>
    expect((await owner.status(request)).error).toBe('Replacement failed')
  )
  expect((await owner.status(request)).result).toEqual(saved)
  await owner.close()
})

it('checks managed session images before invoking the main model or narration', async () => {
  const f = await fixture()
  f.options.loadSession = async () => ({
    ...session,
    messages: [{ ...session.messages[0], content: '![Missing](missing.png)' }, session.messages[1]]
  })
  const owner = createResearchVideoPresentationOwner(f.options)
  await owner.start(request)
  await vi.waitFor(async () =>
    expect((await owner.status(request)).preflightError).toContain('available managed Artifact')
  )
  expect(f.options.writeScreenplay).not.toHaveBeenCalled()
  expect(f.options.generate).not.toHaveBeenCalled()
  await owner.close()
})

it.each([
  ['empty', []],
  ['awaiting-reply', [session.messages[0]]],
  ['busy', [session.messages[0], { ...session.messages[1], status: 'streaming' }]]
] as const)(
  'blocks %s sources before acquiring models or starting generation',
  async (reason, messages) => {
    const f = await fixture()
    f.options.loadSession = async () => ({ ...session, messages: [...messages] })
    const owner = createResearchVideoPresentationOwner(f.options)
    try {
      expect((await owner.status(request)).generationBlock).toBe(reason)
      await owner.start(request)
      await vi.waitFor(async () =>
        expect((await owner.status(request)).preflightError).toBeDefined()
      )
      expect(f.options.models.acquireUse).not.toHaveBeenCalled()
      expect(f.options.writeScreenplay).not.toHaveBeenCalled()
      expect(f.options.generate).not.toHaveBeenCalled()
    } finally {
      await owner.close()
    }
  }
)

it('checks selected branch content and allows completed explanations of unsuccessful research', () => {
  expect(researchVideoGenerationBlock({ ...session, status: 'error' }, request)).toBeUndefined()
  expect(researchVideoGenerationBlock({ ...session, status: 'running' }, request)).toBe('busy')
  const conversationGraph = {
    rootFrameId: 'frame',
    frames: [{ id: 'frame', activeBranchId: 'question' }],
    branches: [
      { id: 'question', agentFrameId: 'frame', headMessageId: 'q' },
      { id: 'answered', agentFrameId: 'frame', headMessageId: 'a' }
    ],
    messages: [
      { ...session.messages[0], id: 'q', agentFrameId: 'frame' },
      { ...session.messages[1], id: 'a', agentFrameId: 'frame' }
    ]
  } as NonNullable<PersistedChatSession['conversationGraph']>
  expect(researchVideoGenerationBlock({ ...session, conversationGraph }, request)).toBe(
    'awaiting-reply'
  )
  expect(
    researchVideoGenerationBlock(
      { ...session, conversationGraph },
      { ...request, branchId: 'answered' }
    )
  ).toBeUndefined()
  expect(
    researchVideoGenerationBlock(
      { ...session, conversationGraph },
      { ...request, branchId: 'missing' }
    )
  ).toBe('unavailable')
})

it('never returns a saved player once its session is unavailable', async () => {
  const f = await fixture()
  const owner = createResearchVideoPresentationOwner(f.options)
  await owner.start(request)
  await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
  f.options.loadSession = async () => undefined
  expect(await owner.status(request)).toEqual({ generationBlock: 'unavailable' })
  await owner.close()
})

it('removes saved versions through the host mutation lane and allows a fresh generation', async () => {
  const f = await fixture()
  const mutate = vi.fn(async (_request, work) => work())
  const owner = createResearchVideoPresentationOwner({ ...f.options, mutate })
  await owner.start(request)
  await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  const saved = (await owner.status(request)).result!
  expect((await owner.remove(request)).result).toBeUndefined()
  expect(mutate).toHaveBeenCalledOnce()
  await expect(readFile(saved.playerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await owner.close()
  const reopened = createResearchVideoPresentationOwner(f.options)
  expect((await reopened.status(request)).result).toBeUndefined()
  await reopened.start(request)
  await vi.waitFor(async () => expect((await reopened.status(request)).result).toBeDefined())
  expect((await reopened.status(request)).result!.id).not.toBe(saved.id)
  await reopened.close()
})

it.each([['missing image', '![Missing](missing.png)', 'available managed Artifact']])(
  'rejects %s material at preflight and direct start without creating a job',
  async (_case, content, reason) => {
    const f = await fixture()
    f.options.loadSession = async () => ({
      ...session,
      messages: [{ ...session.messages[0], content }, session.messages[1]]
    })
    const owner = createResearchVideoPresentationOwner(f.options)
    try {
      expect((await owner.status({ ...request, checkReadiness: true })).preflightError).toContain(
        reason
      )
      const result = await owner.start(request)
      expect(result.preflightError).toContain(reason)
      expect(result.progress).toBeUndefined()
      expect(f.options.models.acquireUse).not.toHaveBeenCalled()
      expect(f.options.writeScreenplay).not.toHaveBeenCalled()
      expect(await readdir(f.options.dataRoot())).toEqual([])
    } finally {
      await owner.close()
    }
  }
)

it('keeps a saved film available and refreshes admission after readiness is repaired', async () => {
  const f = await fixture()
  const checkReadiness = vi.fn(async () => {})
  const owner = createResearchVideoPresentationOwner({ ...f.options, checkReadiness })
  try {
    await owner.start(request)
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    const saved = (await owner.status(request)).result
    checkReadiness.mockRejectedValue(new Error('Runtime unavailable'))
    expect(await owner.status({ ...request, checkReadiness: true })).toMatchObject({
      result: saved,
      preflightError: 'Runtime unavailable'
    })
    expect((await owner.start(request)).preflightError).toBe('Runtime unavailable')
    expect(f.options.writeScreenplay).toHaveBeenCalledOnce()
    checkReadiness.mockResolvedValue(undefined)
    expect(
      (await owner.status({ ...request, checkReadiness: true })).preflightError
    ).toBeUndefined()
    expect((await owner.status(request)).result).toEqual(saved)
  } finally {
    await owner.close()
  }
})

it('discards a delayed preflight failure after a newer generation succeeds', async () => {
  const f = await fixture()
  let rejectProbe!: (error: Error) => void
  const checkReadiness = vi
    .fn(async () => {})
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectProbe = reject
        })
    )
  const owner = createResearchVideoPresentationOwner({ ...f.options, checkReadiness })
  try {
    const oldProbe = owner.status({ ...request, checkReadiness: true })
    await vi.waitFor(() => expect(checkReadiness).toHaveBeenCalledOnce())
    await owner.start(request)
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    const saved = (await owner.status(request)).result
    rejectProbe(new Error('Obsolete runtime failure'))
    expect(await oldProbe).toMatchObject({ result: saved })
    expect((await owner.status(request)).preflightError).toBeUndefined()
  } finally {
    await owner.close()
  }
})

it('times out a stalled readiness check before the Film starts', async () => {
  const f = await fixture()
  const probe = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const checkReadiness = vi.fn<(signal?: AbortSignal) => Promise<void>>(() => {
    entered.resolve()
    return probe.promise
  })
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const owner = createResearchVideoPresentationOwner({ ...f.options, checkReadiness })
  try {
    const pending = owner.status({ ...request, checkReadiness: true })
    await entered.promise
    deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'))
    const outcome = vi.fn()
    void pending.then(outcome, outcome)
    await vi.waitFor(() =>
      expect(outcome).toHaveBeenCalledWith({
        preflightError: expect.stringMatching(/timed out/i)
      })
    )
    expect(checkReadiness.mock.calls[0][0]?.aborted).toBe(true)
    expect((await owner.status(request)).preflightError).toMatch(/timed out/i)
    expect(f.options.writeScreenplay).not.toHaveBeenCalled()

    await expect(owner.status({ ...request, checkReadiness: true })).resolves.toMatchObject({
      preflightError: expect.stringMatching(/timed out/i)
    })
    expect(checkReadiness).toHaveBeenCalledOnce()
    probe.resolve()
    timeout.mockRestore()
    checkReadiness.mockResolvedValueOnce(undefined)
    await vi.waitFor(async () =>
      expect(
        (await owner.status({ ...request, checkReadiness: true })).preflightError
      ).toBeUndefined()
    )
  } finally {
    timeout.mockRestore()
    probe.resolve()
    await owner.close()
  }
})

it('reports a stalled checkpoint write without letting a retry race it', async () => {
  const f = await fixture()
  const write = vi.mocked(writeDurableJsonFile)
  const original = write.getMockImplementation()!
  const entered = Promise.withResolvers<void>()
  const disk = Promise.withResolvers<void>()
  write.mockImplementation(async (...args) => {
    if (!args[0].endsWith('session.json')) return original(...args)
    vi.useFakeTimers()
    entered.resolve()
    await disk.promise
    await original(...args)
  })
  const owner = createResearchVideoPresentationOwner(f.options)
  try {
    await owner.start(request)
    await entered.promise
    owner.cancel(request)
    await vi.advanceTimersByTimeAsync(5000)
    vi.useRealTimers()
    await vi.waitFor(
      async () => {
        expect(await owner.status(request)).toMatchObject({
          progress: { phase: 'failed' },
          error: expect.stringMatching(/still waiting for the disk/i)
        })
      },
      { timeout: 400 }
    )
    await expect(owner.start(request)).rejects.toThrow(/still waiting for the disk/i)
    expect(f.options.writeScreenplay).not.toHaveBeenCalled()
    disk.resolve()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    expect(f.options.writeScreenplay).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
    disk.resolve()
    await owner.close()
    write.mockImplementation(original)
  }
})

it('cancels a stalled prepublication session read without discarding the built Film', async () => {
  const f = await fixture()
  const lookup = Promise.withResolvers<PersistedChatSession>()
  const entered = Promise.withResolvers<void>()
  let stall = true
  const generate = f.options.generate.getMockImplementation()!
  f.options.generate.mockImplementation(async (...args) => {
    const result = await generate(...args)
    if (stall)
      vi.mocked(f.options.loadSession).mockImplementationOnce(() => {
        entered.resolve()
        return lookup.promise
      })
    return result
  })
  const owner = createResearchVideoPresentationOwner(f.options)
  try {
    await owner.start(request)
    await entered.promise
    owner.cancel(request)
    await vi.waitFor(
      async () => {
        expect(await owner.status(request)).toMatchObject({
          progress: { phase: 'cancelled' },
          canResume: true
        })
        expect(f.release).toHaveBeenCalledOnce()
      },
      { timeout: 400 }
    )
    stall = false
    await owner.start({ ...request, resume: true })
    await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
    expect(f.options.generate).toHaveBeenCalledOnce()
  } finally {
    lookup.resolve(session)
    await owner.close()
  }
})

it('bounds a stalled status read without starting another one', async () => {
  const f = await fixture()
  const lookup = Promise.withResolvers<PersistedChatSession>()
  const loadSession = vi.fn(async () => session).mockImplementationOnce(() => lookup.promise)
  const owner = createResearchVideoPresentationOwner({ ...f.options, loadSession })
  vi.useFakeTimers()
  try {
    const first = owner.status(request).catch((error: unknown) => error)
    const retry = owner.status(request).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(loadSession).toHaveBeenCalledOnce()
    expect(await first).toMatchObject({ message: expect.stringMatching(/status.*timed out/i) })
    expect(await retry).toBe(await first)
    await expect(owner.status(request)).rejects.toThrow(/status.*timed out/i)
    expect(loadSession).toHaveBeenCalledOnce()
    lookup.resolve(session)
    await vi.advanceTimersByTimeAsync(0)
    await expect(owner.status(request)).resolves.toEqual({})
    expect(loadSession).toHaveBeenCalledTimes(2)
  } finally {
    lookup.resolve(session)
    vi.useRealTimers()
    await owner.close()
  }
})

it('keeps a known Film playable and allows regeneration with a corrupt latest receipt', async () => {
  const f = await fixture()
  const owner = createResearchVideoPresentationOwner(f.options)
  try {
    await owner.start(request)
    await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    const old = (await owner.status(request)).result!
    const latest = join(dirname(dirname(dirname(old.playerPath))), 'latest.json')
    await writeFile(latest, '{')
    expect((await owner.status(request)).result).toEqual(old)
    await owner.close()
    const restarted = createResearchVideoPresentationOwner(f.options)
    try {
      expect(await restarted.status(request)).toMatchObject({
        error: expect.stringMatching(/receipt/i)
      })
      await restarted.start(request)
      await vi.waitFor(async () => {
        const result = (await restarted.status(request)).result
        expect(result?.id).toBeDefined()
        expect(result?.id).not.toBe(old.id)
      })
      expect(await readFile(old.playerPath, 'utf8')).toContain('Generated')
    } finally {
      await restarted.close()
    }
  } finally {
    await owner.close()
  }
})

it.each(['player.html', 'sources.zip'])(
  'rebuilds an empty %s while keeping the screenplay checkpoint and old Film',
  async (emptyFile) => {
    const f = await fixture()
    const lookup = Promise.withResolvers<PersistedChatSession>()
    const entered = Promise.withResolvers<void>()
    const owner = createResearchVideoPresentationOwner(f.options)
    try {
      await owner.start(request)
      await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
      await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
      const old = (await owner.status(request)).result!
      const build = f.options.generate.getMockImplementation()!
      f.options.generate.mockImplementationOnce(async (...args) => {
        const result = await build(...args)
        await writeFile(emptyFile === 'player.html' ? result.playerPath : result.sourcePath, '')
        vi.mocked(f.options.loadSession).mockImplementationOnce(() => {
          entered.resolve()
          return lookup.promise
        })
        return result
      })
      await owner.start(request)
      // Interrupt after the built receipt is on disk, before publication.
      await entered.promise
      owner.cancel(request)
      await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(2))
      expect((await owner.status(request)).result).toEqual(old)
      if (emptyFile === 'sources.zip') {
        const base = dirname(dirname(dirname(old.playerPath)))
        const pending = JSON.parse(await readFile(join(base, 'pending.json'), 'utf8'))
        await rename(join(base, 'pending'), join(base, pending.id))
      }
      await owner.start({ ...request, resume: true })
      await vi.waitFor(async () => {
        const current = (await owner.status(request)).result
        expect(current?.id).toBeDefined()
        expect(current?.id).not.toBe(old.id)
      })
      const current = (await owner.status(request)).result!
      expect(await readFile(current.playerPath, 'utf8')).toContain('Generated')
      expect(await readFile(current.sourcePath, 'utf8')).toBe('source')
      expect(f.options.generate).toHaveBeenCalledTimes(3)
      expect(f.options.writeScreenplay).toHaveBeenCalledTimes(2)
      expect(await readFile(old.playerPath, 'utf8')).toContain('Generated')
    } finally {
      lookup.resolve(session)
      await owner.close()
    }
  }
)

it('releases admission on cancel even if model verification returns a lease later', async () => {
  const f = await fixture()
  const acquire = f.options.models.acquireUse
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof acquire>>>()
  const entered = vi.fn()
  const owner = createResearchVideoPresentationOwner({
    ...f.options,
    models: {
      ...f.options.models,
      acquireUse: () => {
        entered()
        return pending.promise
      }
    }
  })
  try {
    const starting = owner.start(request)
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    owner.cancel(request)
    const outcome = vi.fn()
    void starting.then(outcome, outcome)
    await vi.waitFor(() =>
      expect(outcome).toHaveBeenCalledWith(
        expect.objectContaining({ progress: expect.objectContaining({ phase: 'cancelled' }) })
      )
    )
    expect(f.options.writeScreenplay).not.toHaveBeenCalled()
    pending.resolve(await acquire())
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  } finally {
    if (!f.release.mock.calls.length) pending.resolve(await acquire())
    await owner.close()
  }
})

it('releases Film admission when a shared readiness check is cancelled', async () => {
  const f = await fixture()
  const probe = Promise.withResolvers<void>()
  const checkReadiness = vi
    .fn<(signal?: AbortSignal) => Promise<void>>(async () => {})
    .mockImplementationOnce(() => probe.promise)
  const other = { ...request, sessionId: 'other' }
  const owner = createResearchVideoPresentationOwner({
    ...f.options,
    checkReadiness,
    loadSession: async (_projectId, sessionId) => ({ ...session, id: sessionId })
  })
  try {
    const first = owner.start(request)
    await vi.waitFor(() => expect(checkReadiness).toHaveBeenCalledOnce())
    const duplicate = owner.start(request)
    await expect(owner.start(other)).rejects.toThrow('Another research explanation')
    owner.cancel(request)
    const settled = vi.fn()
    void Promise.all([first, duplicate]).then(settled, settled)
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    await Promise.all([first, duplicate])
    expect(checkReadiness.mock.calls[0][0]?.aborted).toBe(true)
    expect((await owner.status(request)).progress?.phase).toBe('cancelled')
    expect(f.options.models.acquireUse).not.toHaveBeenCalled()
    expect(f.options.writeScreenplay).not.toHaveBeenCalled()
    expect(await readdir(f.options.dataRoot())).toEqual([])

    await owner.start(other)
    expect(checkReadiness).toHaveBeenCalledTimes(2)
    probe.reject(new Error('Obsolete readiness failure'))
    await vi.waitFor(async () => expect((await owner.status(other)).result).toBeDefined())
    expect((await owner.status(request)).progress?.phase).toBe('cancelled')
  } finally {
    probe.resolve()
    await owner.close()
  }
})

it('shares a readiness refresh across concurrent callers', async () => {
  const f = await fixture()
  const probe = Promise.withResolvers<void>()
  const checkReadiness = vi.fn(() => probe.promise)
  const owner = createResearchVideoPresentationOwner({ ...f.options, checkReadiness })
  try {
    const first = owner.status({ ...request, checkReadiness: true })
    const second = owner.status({ ...request, checkReadiness: true })
    await vi.waitFor(() => expect(checkReadiness).toHaveBeenCalledOnce())
    probe.resolve()
    expect(await second).toEqual(await first)
    expect(checkReadiness).toHaveBeenCalledOnce()
  } finally {
    probe.resolve()
    await owner.close()
  }
})

it('retains conversation text and Artifact references above the former byte cap', () => {
  const content = 'Research evidence. '.repeat(40_000)
  const source = researchVideoSessionSource(
    {
      ...session,
      messages: [
        { ...session.messages[0], content, artifactIds: ['plot-version'] },
        session.messages[1]
      ]
    },
    request
  )
  expect(source.messages[0]).toMatchObject({
    i: 0,
    id: 'question',
    md: content,
    artifactIds: ['plot-version']
  })
  expect(Buffer.byteLength(JSON.stringify(source))).toBeGreaterThan(512 * 1024)
})

it('reuses a large screenplay checkpoint when resuming after a failed build', async () => {
  const f = await fixture()
  f.options.writeScreenplay.mockResolvedValue(script + ' '.repeat(520 * 1024))
  f.options.generate.mockRejectedValueOnce(new Error('Worker stopped'))
  const first = createResearchVideoPresentationOwner(f.options)
  await first.start(request)
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  await first.close()
  const reopened = createResearchVideoPresentationOwner(f.options)
  expect(await reopened.status(request)).toMatchObject({ canResume: true, filmStep: 4 })
  await reopened.start({ ...request, resume: true })
  await vi.waitFor(async () =>
    expect((await reopened.status(request)).result?.title).toBe('Rainfall uncertainty')
  )
  expect(f.options.writeScreenplay).toHaveBeenCalledOnce()
  expect(f.options.generate).toHaveBeenCalledTimes(2)
  expect((await reopened.status(request)).canResume).toBeUndefined()
  await reopened.close()
})

it('does not persist a checkpoint whose JSON escaping exceeds the recovery budget', async () => {
  const f = await fixture()
  const checkpoint = filmAuthoringCheckpoint(f.options.dataRoot(), vi.fn())
  await checkpoint.save('screenplay', '\\'.repeat(4 * 1024 * 1024))
  expect(await readdir(f.options.dataRoot())).toEqual([])
})

it('correlates preparation failures without retaining private error text', async () => {
  const f = await fixture()
  const owner = createResearchVideoPresentationOwner({
    ...f.options,
    checkReadiness: async () => {
      throw Object.assign(new Error('private research /private/path'), { code: 'EACCES' })
    }
  })
  timing.mockClear()
  await owner.start(request)
  await owner.close()
  const started = timing.mock.calls.find(([event]) => event === 'film invocation started')![1]
  expect(started.invocationId).toBeTruthy()
  expect(timing).toHaveBeenCalledWith(
    'film attempt stopped',
    expect.objectContaining({
      invocationId: started.invocationId,
      operationId: started.operationId,
      sessionId: request.sessionId,
      phase: 'readiness',
      outcome: 'failed',
      errorCategory: 'permission'
    })
  )
  expect(timing).toHaveBeenCalledWith(
    'generation timing',
    expect.objectContaining({ invocationId: started.invocationId })
  )
  expect(JSON.stringify(timing.mock.calls)).not.toContain('private research')
  expect(JSON.stringify(timing.mock.calls)).not.toContain('/private/path')
})

it('records an incomplete narration installation without starting authoring', async () => {
  const f = await fixture()
  f.options.models.installForUse = vi.fn(async () => ({
    ...(await f.options.models.getSnapshot()),
    availability: 'notInstalled' as const
  }))
  const owner = createResearchVideoPresentationOwner(f.options)
  timing.mockClear()
  await owner.start({ ...request, installNarration: true })
  await owner.close()
  expect(f.options.writeScreenplay).not.toHaveBeenCalled()
  expect(timing).toHaveBeenCalledWith(
    'film attempt stopped',
    expect.objectContaining({
      sessionId: request.sessionId,
      phase: 'narration-install',
      errorCategory: 'installation-incomplete'
    })
  )
})
