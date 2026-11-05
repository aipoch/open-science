import { parseResearchVideoScreenplay } from '@aipoch/research-film'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { LocalModelOwner } from '../local-models/owner'
import { createResearchVideoPresentationOwner } from './presentation'
import { researchVideoSessionSource, researchVideoGenerationBlock } from './session-source'

const { timing } = vi.hoisted(() => ({ timing: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', () => ({ createLogger: () => ({ info: timing }) }))

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
  } as unknown as LocalModelOwner
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
    outcome: 'completed',
    totalMs: expect.any(Number),
    stagesMs: {
      preparing: expect.any(Number),
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

it('authors original skill animation files before starting narration and player generation', async () => {
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
  const writeAnimation = vi.fn<NonNullable<Options['writeAnimation']>>(async (_source, input) =>
    input.shared ? 'function rain(k) { k.ctx.fillRect(0, 0, 20, 20); }' : 'rain(k);'
  )
  const generate = f.options.generate.getMockImplementation()!
  f.options.generate.mockImplementation(async (...args) => {
    const spec = JSON.parse(await readFile(args[0].specPath, 'utf8'))
    expect(spec.scenes[0].panels[1].script).toBe('anims/hook.js')
    expect(await readFile(join(args[0].specPath, '..', 'anims/hook.js'), 'utf8')).toBe('rain(k);')
    expect(writeAnimation).toHaveBeenCalledTimes(2)
    return generate(...args)
  })
  const owner = createResearchVideoPresentationOwner({ ...f.options, writeAnimation })
  try {
    await owner.start(request)
    await vi.waitFor(async () => expect((await owner.status(request)).result).toBeDefined())
    expect(f.options.generate).toHaveBeenCalledOnce()
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
  expect(f.release).toHaveBeenCalledOnce()
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

it('reserves admission across duplicate starts and cancels before acquiring resources', async () => {
  const f = await fixture()
  let finishProbe!: () => void
  const checkReadiness = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishProbe = resolve
      })
  )
  const owner = createResearchVideoPresentationOwner({ ...f.options, checkReadiness })
  try {
    const first = owner.start(request)
    await vi.waitFor(() => expect(checkReadiness).toHaveBeenCalledOnce())
    const duplicate = owner.start(request)
    await expect(owner.start({ ...request, sessionId: 'other' })).rejects.toThrow(
      'Another research explanation'
    )
    owner.cancel(request)
    finishProbe()
    await Promise.all([first, duplicate])
    expect(checkReadiness).toHaveBeenCalledOnce()
    expect((await owner.status(request)).progress?.phase).toBe('cancelled')
    expect(f.options.models.acquireUse).not.toHaveBeenCalled()
    expect(f.options.writeScreenplay).not.toHaveBeenCalled()
    expect(await readdir(f.options.dataRoot())).toEqual([])
  } finally {
    await owner.close()
  }
})

it('keeps the newest readiness result when concurrent refreshes finish out of order', async () => {
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
    await owner.status({ ...request, checkReadiness: true })
    rejectProbe(new Error('Obsolete failure'))
    expect((await oldProbe).preflightError).toBeUndefined()
    expect((await owner.status(request)).preflightError).toBeUndefined()
    expect(checkReadiness).toHaveBeenCalledTimes(2)
  } finally {
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
