import { expect, it, vi } from 'vitest'
import { createRuntimePayloadClient } from './runtime-payload-client'
import {
  RUNTIME_PAYLOAD_INLINE_BYTES,
  type RuntimePayloadOptions
} from './runtime-payload-transfer'

const snapshotId = '1ea273f7-b0b1-4410-a770-c6c7f9329588'
type Invoke = Parameters<typeof createRuntimePayloadClient>[0]['invoke']
const client = (
  invoke: Invoke,
  signal = new AbortController().signal
): ReturnType<typeof createRuntimePayloadClient> =>
  createRuntimePayloadClient({
    invoke,
    encode: JSON.stringify,
    decode: JSON.parse,
    signal: () => signal
  })

it('reassembles UTF-8 split inside a character and releases the immutable snapshot', async () => {
  const value = { message: '科学😀', revision: 42 }
  const bytes = Buffer.from(JSON.stringify(value))
  const invoke = vi.fn<Invoke>(async (_channel, _args, options) => {
    const request = options?.transfer
    if (!request) return { $payload: { snapshotId, byteLength: bytes.length } }
    if (request.kind === 'release') return null
    if (request.kind !== 'read') throw new Error('Unexpected transfer')
    return {
      snapshotId,
      offset: request.offset,
      nextOffset: request.offset + 1,
      data: bytes.subarray(request.offset, request.offset + 1).toString('base64')
    }
  })
  await expect(client(invoke).invoke('sessions:load-one', [{}])).resolves.toEqual(value)
  expect(invoke.mock.calls.at(-1)?.[2]?.transfer).toEqual({ kind: 'release', snapshotId })
})

it.each([
  { snapshotId: '43c2cdf7-5a4a-4b6c-8e7d-837edffca141' },
  { offset: 1 },
  { nextOffset: 3 },
  { data: '' }
])('rejects a mismatched snapshot page and releases the token: %j', async (invalid) => {
  const invoke = vi.fn<Invoke>(async (_channel, _args, options) => {
    if (!options?.transfer) return { $payload: { snapshotId, byteLength: 2 } }
    if (options.transfer.kind === 'release') return null
    return { snapshotId, offset: 0, nextOffset: 2, data: 'e30=', ...invalid }
  })
  await expect(client(invoke).invoke('notebook:state', [{}])).rejects.toThrow(
    'Invalid payload snapshot page'
  )
  expect(invoke.mock.calls.at(-1)?.[2]?.transfer).toEqual({ kind: 'release', snapshotId })
})

it('does not retry a save whose commit response was lost', async () => {
  const operations: string[] = []
  const invoke = vi.fn<Invoke>(async (_channel, _args, options) => {
    const request = options?.transfer
    if (!request) throw new Error('Expected chunked upload')
    operations.push(request.kind)
    if (request.kind === 'upload')
      return { $payload: { snapshotId, byteLength: request.byteLength } }
    if (request.kind === 'append')
      return { nextOffset: request.offset + Buffer.from(request.data, 'base64').length }
    if (request.kind === 'commit') throw new Error('Response lost after commit')
    if (request.kind === 'release') return null
    throw new Error('Unexpected read')
  })
  await expect(
    client(invoke).invoke('sessions:save-session', [
      { text: 'x'.repeat(RUNTIME_PAYLOAD_INLINE_BYTES) }
    ])
  ).rejects.toThrow('Response lost after commit')
  expect(operations.filter((kind) => kind === 'commit')).toHaveLength(1)
  expect(operations.at(-1)).toBe('release')
})

it('releases a snapshot on abort and never installs its late page', async () => {
  const controller = new AbortController()
  let complete!: (value: unknown) => void
  const invoke = vi.fn<Invoke>(async (_channel, _args, options) => {
    if (!options?.transfer) return { $payload: { snapshotId, byteLength: 2 } }
    if (options.transfer.kind === 'release') return null
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  const pending = client(invoke, controller.signal).invoke('notebook:state', [{}])
  const outcome = expect(pending).rejects.toThrow('Cancelled')
  await vi.waitFor(() => expect(complete).toBeDefined())
  controller.abort(new Error('Cancelled'))
  complete({ snapshotId, offset: 0, nextOffset: 2, data: 'e30=' })
  await outcome
  expect(invoke.mock.calls.at(-1)?.[2]?.transfer).toEqual({ kind: 'release', snapshotId })
})

it('keeps unrelated commands and simultaneous inline reads concurrent', async () => {
  const calls: {
    channel: string
    options?: RuntimePayloadOptions
    resolve: (value: unknown) => void
  }[] = []
  const facade = client(
    (channel, _args, options) =>
      new Promise((resolve) => {
        calls.push({ channel, options, resolve })
      })
  )
  const pending = [
    facade.invoke('notebook:state', [{}]),
    facade.invoke('sessions:load-one', [{}]),
    facade.invoke('projects:list', [])
  ]
  expect(calls.map((call) => call.channel)).toEqual([
    'notebook:state',
    'sessions:load-one',
    'projects:list'
  ])
  expect(calls[2].options).toBeUndefined()
  calls.forEach((call, index) => call.resolve(index))
  await expect(Promise.all(pending)).resolves.toEqual([0, 1, 2])
})
