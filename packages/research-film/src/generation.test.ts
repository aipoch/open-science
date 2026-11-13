import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { createResearchVideoGenerator, generateResearchVideoInWorker } from './generation.js'

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

it.each(['cancel', 'failure'] as const)(
  'terminates every owned worker on %s before cleanup',
  async (reason) => {
    const root = await mkdtemp(join(tmpdir(), 'parallel-workers-'))
    try {
      const controller = new AbortController()
      let stopped!: () => void
      const stopping = new Promise<void>((resolve) => {
        stopped = resolve
      })
      const workers: Array<
        EventEmitter & {
          terminate: ReturnType<typeof vi.fn>
          postMessage: ReturnType<typeof vi.fn>
        }
      > = []
      const generate = createResearchVideoGenerator({
        temporaryRoot: root,
        createWorker: () => {
          const worker = Object.assign(new EventEmitter(), {
            terminate: vi.fn(async () => 1),
            postMessage: vi.fn()
          })
          workers.push(worker)
          if (workers.length === 1)
            queueMicrotask(() => {
              worker.emit('message', { kind: 'synthesize', lane: 0, text: 'First' })
              worker.emit('message', { kind: 'synthesize', lane: 1, text: 'Second' })
              if (reason === 'cancel') controller.abort(new Error('cancelled'))
              else workers[2].emit('error', new Error('speech failed'))
              stopped()
            })
          return worker as unknown as Worker
        }
      })
      const result = generate(
        {
          speechConcurrency: 2,
          specPath: 'unused',
          modelDirectory: 'unused',
          engineDirectory: 'unused',
          outputDirectory: join(root, 'output')
        },
        controller.signal
      ).catch((error) => error)
      await stopping
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(workers[1].terminate).not.toHaveBeenCalled()
      expect(await readdir(root)).toHaveLength(1)
      workers[0].emit('message', { kind: 'synthesize', lane: 0, text: 'Ignored after stop' })
      workers[1].emit('message', { kind: 'speech-duration', lane: 0, duration: 1 })
      if (reason === 'cancel')
        workers[2].emit('message', { kind: 'speech-duration', lane: 1, duration: 1 })
      expect(await result).toMatchObject({
        message: reason === 'cancel' ? 'cancelled' : 'speech failed'
      })
      if (reason === 'failure')
        expect(await result).toMatchObject({ workerRole: 'speech', lane: 1 })
      expect(workers[0].postMessage).not.toHaveBeenCalled()
      expect(workers[1].postMessage).toHaveBeenCalledOnce()
      expect(workers).toHaveLength(3)
      for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce()
      expect(workers[2].postMessage).toHaveBeenCalledTimes(1)
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

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
    const workers: Array<
      EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
    > = []
    const samples = new Float32Array(240)
    const duration = { kind: 'speech-duration', lane: 0, duration: 0.01 }
    const audio = { kind: 'speech-result', lane: 1, audio: { samples, sampleRate: 24000 } }
    const generate = createResearchVideoGenerator({
      temporaryRoot: root,
      createWorker: () => {
        const worker = Object.assign(new EventEmitter(), {
          postMessage: vi.fn(),
          terminate: vi.fn(async () => 1)
        })
        workers.push(worker)
        if (workers.length === 1)
          queueMicrotask(() => {
            worker.emit('message', { kind: 'measure-duration', lane: 0, text: 'one' })
            worker.emit('message', { kind: 'synthesize', lane: 1, text: 'one two' })
            workers[1].emit('message', duration)
            workers[2].emit('message', audio)
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
    expect(workers[1].postMessage).toHaveBeenCalledWith({
      kind: 'measure-duration',
      lane: 0,
      text: 'one'
    })
    expect(workers[0].postMessage).toHaveBeenCalledWith(duration)
    expect(workers[0].postMessage).toHaveBeenCalledWith(audio, [samples.buffer])
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce()
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
      const workers: EventEmitter[] = []
      const generate = createResearchVideoGenerator({
        temporaryRoot: root,
        createWorker: () => {
          const worker = Object.assign(new EventEmitter(), {
            terminate: vi.fn(async () => 1),
            postMessage: vi.fn()
          })
          workers.push(worker)
          if (workers.length === 1)
            queueMicrotask(() => {
              if (role === 'speech')
                worker.emit('message', { kind: 'synthesize', lane: 0, text: 'private narration' })
              workers.at(-1)!.emit('exit', 23)
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
        message: 'Research video worker stopped before completion',
        workerRole: role,
        exitCode: 23,
        lane: role === 'speech' ? 0 : undefined
      })
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
