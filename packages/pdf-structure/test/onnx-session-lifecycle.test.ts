import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { resolve } from './paths'

const { createOnnxSessionLifecycle } = await import(
  pathToFileURL(resolve('resources/literature-pdf-onnx-sessions.mjs')).href
)

it('does not load structure when a single page has no detected tables', async () => {
  const release = vi.fn(),
    create = vi.fn(async (name: string) => {
      expect(name).toBe('detection')
      return { release }
    })
  const owned = createOnnxSessionLifecycle(create, true)
  expect(create).not.toHaveBeenCalled()
  await owned.get('detection')
  await owned.afterDetection()
  await owned.close()
  expect(create.mock.calls.map((c) => c[0])).toEqual(['detection'])
  expect(release).toHaveBeenCalledTimes(1)
})

it('releases detached detection before loading structure and reuses structure crops', async () => {
  const events: string[] = [],
    create = vi.fn(async (name: string) => {
      events.push('create ' + name)
      return {
        release: async (): Promise<void> => {
          events.push('release ' + name)
        }
      }
    }),
    owned = createOnnxSessionLifecycle(create, true)
  await owned.get('detection')
  await owned.afterDetection()
  expect(await owned.get('structure')).toBe(await owned.get('structure'))
  await owned.close()
  await owned.close()
  expect(events).toEqual([
    'create detection',
    'release detection',
    'create structure',
    'release structure'
  ])
  await expect(owned.get('detection')).rejects.toThrow()
})

it('keeps sessions alive across a multi-page request without reloading models', async () => {
  const releases = { detection: vi.fn(), structure: vi.fn() },
    create = vi.fn(async (name: keyof typeof releases) => ({ release: releases[name] })),
    owned = createOnnxSessionLifecycle(create, false)
  for (let page = 0; page < 3; page++) {
    await owned.get('detection')
    await owned.afterDetection()
    await owned.get('structure')
  }
  expect(releases.detection).not.toHaveBeenCalled()
  expect(create).toHaveBeenCalledTimes(2)
  await owned.close()
  expect(releases.detection).toHaveBeenCalledTimes(1)
  expect(releases.structure).toHaveBeenCalledTimes(1)
})

it('does not permit structure allocation before single-page detection has been released', async () => {
  const create = vi.fn(async () => ({ release: vi.fn() })),
    owned = createOnnxSessionLifecycle(create, true)
  await owned.get('detection')
  await expect(owned.get('structure')).rejects.toThrow('Invalid ONNX session lifecycle')
  expect(create).toHaveBeenCalledTimes(1)
  await owned.close()
})

it('waits for an in-flight detection release during cancellation', async () => {
  let finish!: () => void
  const released = new Promise<void>((resolve) => {
      finish = resolve
    }),
    owned = createOnnxSessionLifecycle(async () => ({ release: () => released }), true)
  await owned.get('detection')
  const releasing = owned.afterDetection(),
    closed = vi.fn(),
    closing = owned.close().then(closed)
  await Promise.resolve()
  expect(closed).not.toHaveBeenCalled()
  finish()
  await releasing
  await closing
  expect(closed).toHaveBeenCalledTimes(1)
})

it('releases an in-flight creation after cancellation and prevents subsequent use', async () => {
  let ready!: (value: { release: () => Promise<void> }) => void
  const release = vi.fn(async () => {}),
    owned = createOnnxSessionLifecycle(
      () =>
        new Promise((resolve) => {
          ready = resolve
        }),
      true
    ),
    pending = owned.get('detection'),
    closing = owned.close()
  ready({ release })
  await expect(pending).rejects.toThrow()
  await closing
  expect(release).toHaveBeenCalledTimes(1)
  await expect(owned.get('structure')).rejects.toThrow()
})

it('cleans other loaded sessions even when release fails', async () => {
  const release = vi.fn(),
    owned = createOnnxSessionLifecycle(
      async (name: string) => ({
        release:
          name === 'detection'
            ? async (): Promise<void> => {
                throw Error('Release failed')
              }
            : release
      }),
      false
    )
  await owned.get('detection')
  await owned.get('structure')
  await expect(owned.close()).rejects.toThrow('Release failed')
  expect(release).toHaveBeenCalledTimes(1)
})

it('retains cleanup after session creation fails', async () => {
  const release = vi.fn(),
    owned = createOnnxSessionLifecycle(async (name: string) => {
      if (name === 'structure') throw Error('Create failed')
      return { release }
    }, false)
  await owned.get('detection')
  await expect(owned.get('structure')).rejects.toThrow('Create failed')
  await owned.close()
  expect(release).toHaveBeenCalledTimes(1)
})
