import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
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

it('reuses complete speech after a player build fails and replaces a damaged mix', async () => {
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
    for (const expectedCalls of [1, 1, 2]) {
      if (expectedCalls === 2) await writeFile(join(root, 'speech', 'mix.wav'), 'damaged')
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
      expect(synthesize).toHaveBeenCalledTimes(expectedCalls)
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
