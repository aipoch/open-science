import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { researchFilmResources } from './resources.js'
import {
  createResearchVideoGenerator,
  generateResearchVideoInWorker,
  ResearchVideoSpeechCleanupError
} from './generation.js'

const stubWorker = (): EventEmitter & {
  terminate: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
} =>
  Object.assign(new EventEmitter(), {
    terminate: vi.fn(async () => 1),
    postMessage: vi.fn(),
    unref: vi.fn()
  })

const stubChild = (): EventEmitter & {
  pid: number
  connected: boolean
  send: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
} =>
  Object.assign(new EventEmitter(), {
    pid: 1234,
    connected: true,
    send: vi.fn(),
    disconnect: vi.fn(),
    kill: vi.fn(() => true),
    unref: vi.fn()
  })
const input = (root: string): Parameters<ReturnType<typeof createResearchVideoGenerator>>[0] => ({
  speechConcurrency: 2,
  specPath: 'unused',
  modelDirectory: 'unused',
  engineDirectory: 'unused',
  outputDirectory: join(root, 'output')
})

describe('research video worker ownership', () => {
  it('terminates CPU work and removes temporary files on cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-worker-'))
    try {
      const controller = new AbortController()
      const worker = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> }
      worker.terminate = vi.fn(async () => {
        worker.emit('exit', 1)
        return 1
      })
      const generate = createResearchVideoGenerator({
        temporaryRoot: root,
        createWorker: () => {
          queueMicrotask(() => controller.abort(new Error('cancelled')))
          return worker as unknown as Worker
        }
      })
      await expect(
        generate(
          {
            specPath: 'unused',
            modelDirectory: 'unused',
            engineDirectory: 'unused',
            outputDirectory: join(root, 'output')
          },
          controller.signal
        )
      ).rejects.toThrow('cancelled')
      expect(worker.terminate).toHaveBeenCalledOnce()
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('times out a build worker that stops sending progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-stuck-build-'))
  const worker = stubWorker()
  const controller = new AbortController()
  const building = Promise.withResolvers<void>()
  const generate = createResearchVideoGenerator({
    temporaryRoot: root,
    createWorker: () => {
      vi.useFakeTimers()
      queueMicrotask(() =>
        worker.emit('message', { kind: 'progress', progress: { phase: 'build' } })
      )
      return worker as unknown as Worker
    }
  })
  const failed = vi.fn()
  const result = generate(input(root), controller.signal, () => building.resolve()).catch(failed)
  try {
    await building.promise
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(worker.terminate).toHaveBeenCalledOnce()
    await result
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/build.*timed out/i) })
    )
    expect(await readdir(root)).toEqual([])
  } finally {
    controller.abort()
    await result
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})

it('reports unconfirmed build shutdown and keeps scratch reserved until termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-stuck-build-exit-'))
  const worker = stubWorker()
  const controller = new AbortController()
  const stopping = Promise.withResolvers<number>()
  worker.terminate.mockReturnValue(stopping.promise)
  const entered = Promise.withResolvers<void>()
  const generate = createResearchVideoGenerator({
    temporaryRoot: root,
    createWorker: () => {
      vi.useFakeTimers()
      queueMicrotask(() => entered.resolve())
      return worker as unknown as Worker
    }
  })
  const failed = vi.fn()
  const task = generate(input(root), controller.signal).catch(failed)
  try {
    await entered.promise
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/build worker did not confirm shutdown/i)
      })
    )
    expect(await readdir(root)).toHaveLength(1)
    expect(worker.unref).toHaveBeenCalledOnce()
    expect(generate.assertReady).toThrow(/shutdown/i)
    stopping.resolve(1)
    vi.useRealTimers()
    await vi.waitFor(async () => {
      expect(generate.assertReady).not.toThrow()
      expect(await readdir(root)).toEqual([])
    })
  } finally {
    stopping.resolve(1)
    await task
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})

it('reaps the one real child even when neither narration lane answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-stuck-narration-'))
  const path = join(root, 'stuck.cjs')
  const controller = new AbortController()
  const worker = stubWorker()
  const started = Promise.withResolvers<ChildProcess>()
  let child: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  try {
    await writeFile(
      path,
      `
      let requests = 0
      process.on('disconnect', () => setInterval(() => {}, 1000))
      process.on('message', () => { if (++requests === 2) process.send('stuck') })
    `
    )
    const createSpeechProcess = vi.fn(() => {
      const owned = fork(path, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      child = owned
      exited = once(owned, 'exit')
      owned.once('message', () => started.resolve(owned))
      owned.once('error', started.reject)
      return owned
    })
    const generate = createResearchVideoGenerator({
      temporaryRoot: root,
      createSpeechProcess,
      createWorker: () => {
        queueMicrotask(() => {
          for (const lane of [0, 1])
            worker.emit('message', { kind: 'synthesize', lane, text: 'Unanswered' })
        })
        return worker as unknown as Worker
      }
    })
    const result = generate(input(root), controller.signal).catch((error) => error)
    await started.promise
    controller.abort(new Error('cancelled'))
    expect(await result).toMatchObject({ message: 'cancelled' })
    const [code, signal] = (await exited) as [number | null, string | null]
    expect(
      signal === 'SIGKILL' || (process.platform === 'win32' && code !== null && code !== 0)
    ).toBe(true)
    expect(createSpeechProcess).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual(['stuck.cjs'])
  } finally {
    child?.kill('SIGKILL')
    await exited?.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

it('bounds a stuck request and fences the generator until the child reports exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-unconfirmed-exit-'))
  const worker = stubWorker()
  const child = stubChild()
  const controller = new AbortController()
  try {
    const entered = Promise.withResolvers<void>()
    child.send.mockImplementation(() => entered.resolve())
    const createSpeechProcess = vi.fn(() => child as unknown as ChildProcess)
    const generate = createResearchVideoGenerator({
      temporaryRoot: root,
      createSpeechProcess,
      createWorker: () => {
        vi.useFakeTimers()
        queueMicrotask(() =>
          worker.emit('message', { kind: 'synthesize', lane: 0, text: 'Unanswered' })
        )
        return worker as unknown as Worker
      }
    })
    const result = generate(input(root), controller.signal).catch((error) => error)
    await entered.promise
    await vi.advanceTimersByTimeAsync(180_000)
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await vi.advanceTimersByTimeAsync(5000)
    const error = await result
    expect(error).toBeInstanceOf(ResearchVideoSpeechCleanupError)
    expect(await readdir(root)).toHaveLength(1)
    await expect(generate(input(root), controller.signal)).rejects.toBe(error)
    expect(createSpeechProcess).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
    child.emit('exit', null, 'SIGKILL')
    await error.exited
    expect(generate.assertReady).not.toThrow()
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]))
  } finally {
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a missing session image before any speech inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-preflight-'))
  try {
    await writeFile(
      join(root, 'video.json'),
      JSON.stringify({
        title: 'Study',
        session: 'session.json',
        scenes: [{ id: 's', msg: 0, lines: [{ caption: 'Evidence.' }], panels: [] }]
      })
    )
    await writeFile(
      join(root, 'session.json'),
      JSON.stringify({ messages: [{ md: '![Evidence](missing.png)' }] })
    )
    const synthesize = vi.fn()
    await expect(
      generateResearchVideoInWorker(
        {
          specPath: join(root, 'video.json'),
          temporaryDirectory: root,
          engineDirectory: root,
          modelDirectory: root,
          outputDirectory: join(root, 'output')
        },
        () => {},
        [{ identity: 'preflight-test', synthesize }]
      )
    ).rejects.toThrow('ENOENT')
    expect(synthesize).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('generates an approved session-app film from frozen bytes through the real worker pipeline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-approved-app-'))
  try {
    const appPath = join(root, 'libs', 'app.js')
    const app = 'window.APP = { position(t) { return t * 2; } };'
    await mkdir(join(root, 'libs'))
    await writeFile(appPath, app)
    await writeFile(join(root, 'libs', 'unapproved.js'), 'private unrelated code')
    await writeFile(
      join(root, 'video.json'),
      JSON.stringify({
        title: 'Evidence',
        session: 'session.json',
        libs: ['libs/app.js'],
        scenes: [{ id: 's', msg: 0, lines: [{ caption: 'Evidence.' }], panels: [] }]
      })
    )
    await writeFile(join(root, 'session.json'), JSON.stringify({ messages: [{ md: 'Evidence.' }] }))
    const provenance = { sessionAppSha256: createHash('sha256').update(app).digest('hex') }
    const synthesize = vi.fn(async () => {
      // A source edit after preflight must not replace the bytes the user approved.
      await writeFile(appPath, 'changed after freezing')
      return { samples: new Float32Array(2400), sampleRate: 24000 }
    })
    const result = await generateResearchVideoInWorker(
      {
        specPath: join(root, 'video.json'),
        temporaryDirectory: root,
        engineDirectory: researchFilmResources().stageDirectory,
        modelDirectory: root,
        outputDirectory: join(root, 'output'),
        provenance
      },
      () => {},
      [{ identity: 'approved-app-test', synthesize }]
    )
    const bundle = unzipSync(await readFile(result.sourcePath))
    expect(Buffer.from(bundle['libs/app.js']).toString()).toBe(app)
    expect(bundle).not.toHaveProperty('libs/unapproved.js')
    expect(JSON.parse(Buffer.from(bundle['manifest.json']).toString()).provenance).toEqual(
      provenance
    )
    expect(await readFile(result.playerPath, 'utf8')).toContain(app)
    expect(await readFile(join(root, 'source', 'libs', 'app.js'), 'utf8')).toBe(app)
    expect(synthesize).toHaveBeenCalledOnce()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['missing-approval', 'changed-app', 'extra-library', 'external-path'])(
  'rejects a session app before narration when its approval boundary fails: %s',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'film-app-preflight-'))
    try {
      const app = 'window.APP = { position(t) { return t; } };'
      const digest = createHash('sha256').update(app).digest('hex')
      await mkdir(join(root, 'libs'))
      await writeFile(join(root, 'libs', 'app.js'), failure === 'changed-app' ? 'changed' : app)
      const libs =
        failure === 'external-path'
          ? ['../app.js']
          : failure === 'extra-library'
            ? ['libs/app.js', 'libs/other.js']
            : ['libs/app.js']
      await writeFile(
        join(root, 'video.json'),
        JSON.stringify({
          title: 'Evidence',
          session: 'session.json',
          libs,
          // Model-authored metadata cannot stand in for the host's consent receipt.
          provenance: { sessionAppSha256: digest },
          scenes: [{ id: 's', msg: 0, lines: [{ caption: 'Evidence.' }], panels: [] }]
        })
      )
      const synthesize = vi.fn()
      await expect(
        generateResearchVideoInWorker(
          {
            specPath: join(root, 'video.json'),
            temporaryDirectory: root,
            engineDirectory: researchFilmResources().stageDirectory,
            modelDirectory: root,
            outputDirectory: join(root, 'output'),
            provenance: failure === 'missing-approval' ? undefined : { sessionAppSha256: digest }
          },
          () => {},
          [{ identity: 'app-boundary-test', synthesize }]
        )
      ).rejects.toThrow(failure === 'changed-app' ? 'approved session app changed' : 'approval')
      expect(synthesize).not.toHaveBeenCalled()
      expect((await readdir(root)).sort()).toEqual(['libs', 'video.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('routes scalar probes without PCM and transfers owned audio buffers to the generation worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'probe-worker-'))
  try {
    const controller = new AbortController()
    const worker = stubWorker()
    const child = stubChild()
    child.kill.mockImplementation(() => child.emit('exit', null, 'SIGKILL'))
    const samples = new Float32Array(240)
    const duration = { kind: 'speech-duration', lane: 0, duration: 0.01 }
    const audio = { kind: 'speech-result', lane: 1, audio: { samples, sampleRate: 24000 } }
    const generate = createResearchVideoGenerator({
      temporaryRoot: root,
      createSpeechProcess: () => child as unknown as ChildProcess,
      createWorker: () => {
        queueMicrotask(() => {
          worker.emit('message', { kind: 'measure-duration', lane: 0, text: 'one' })
          worker.emit('message', { kind: 'synthesize', lane: 1, text: 'one two' })
          child.emit('message', duration)
          child.emit('message', audio)
          controller.abort(new Error('finished routing check'))
        })
        return worker as unknown as Worker
      }
    })
    await expect(
      generate(
        {
          speechConcurrency: 2,
          specPath: 'unused',
          modelDirectory: 'unused',
          engineDirectory: 'unused',
          outputDirectory: join(root, 'output')
        },
        controller.signal
      )
    ).rejects.toThrow('finished routing check')
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'measure-duration', lane: 0, text: 'one' }),
      expect.any(Function)
    )
    expect(worker.postMessage).toHaveBeenCalledWith(duration)
    expect(worker.postMessage).toHaveBeenCalledWith(audio, [samples.buffer])
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('remixes verified speech after a visual edit and resynthesizes damaged recordings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-speech-checkpoint-'))
  try {
    const specPath = join(root, 'video.json')
    await writeFile(
      specPath,
      JSON.stringify({
        title: 'Study',
        session: 'session.json',
        scenes: [{ id: 's', msg: 0, lines: [{ caption: 'Evidence.' }], panels: [] }]
      })
    )
    await writeFile(join(root, 'session.json'), JSON.stringify({ messages: [{ md: 'Evidence.' }] }))
    const synthesize = vi.fn(async () => ({ samples: new Float32Array(2400), sampleRate: 24000 }))
    for (const attempt of ['initial', 'longer-outro', 'corrupt-audio']) {
      if (attempt === 'longer-outro') {
        const spec = JSON.parse(await readFile(specPath, 'utf8'))
        spec.scenes[0].role = 'outro'
        spec.scenes[0].panels = [{ type: 'end_card' }]
        await writeFile(specPath, JSON.stringify(spec))
      }
      if (attempt === 'corrupt-audio')
        await writeFile(join(root, 'speech', 'voice', 's_0.wav'), 'damaged')
      const temporaryDirectory = await mkdtemp(join(root, 'attempt-'))
      const progress = vi.fn()
      await expect(
        generateResearchVideoInWorker(
          {
            specPath,
            retainNarration: true,
            temporaryDirectory,
            engineDirectory: join(root, 'missing-engine'),
            modelDirectory: root,
            outputDirectory: join(temporaryDirectory, 'output')
          },
          progress,
          [{ identity: 'test', synthesize }]
        )
      ).rejects.toThrow()
      expect(progress).toHaveBeenCalledWith({ phase: 'build' })
      expect(synthesize).toHaveBeenCalledTimes(attempt === 'corrupt-audio' ? 2 : 1)
      const mix = await readFile(join(temporaryDirectory, 'mix.wav'))
      expect(mix.length > 48000 * 4 * 5).toBe(attempt !== 'initial')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['generation', 'speech'] as const)(
  'identifies an unexpected %s exit without losing its code',
  async (role) => {
    const root = await mkdtemp(join(tmpdir(), 'film-exit-'))
    try {
      const worker = stubWorker()
      const child = stubChild()
      const generate = createResearchVideoGenerator({
        temporaryRoot: root,
        createSpeechProcess: () => child as unknown as ChildProcess,
        createWorker: () => {
          queueMicrotask(() => {
            if (role === 'speech')
              worker.emit('message', { kind: 'synthesize', lane: 0, text: 'private narration' })
            const exiting = role === 'speech' ? child : worker
            exiting.emit('exit', 23)
          })
          return worker as unknown as Worker
        }
      })
      await expect(
        generate(
          {
            specPath: 'unused',
            modelDirectory: 'unused',
            engineDirectory: 'unused',
            outputDirectory: join(root, 'output')
          },
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        workerRole: role,
        exitCode: 23
      })
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
