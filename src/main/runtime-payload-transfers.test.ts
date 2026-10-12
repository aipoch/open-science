import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { RuntimePayloadTransfers } from './runtime-payload-transfers'
import { ApplicationCallerLeaseRegistry } from './caller-lifecycle'
import { createWebCallerContext } from './caller-context'
import {
  runtimePayloadDescriptorSchema,
  type RuntimePayloadRequest
} from '../shared/runtime-payload-transfer'

let root: string
let owner: RuntimePayloadTransfers
let leases: ApplicationCallerLeaseRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'payload-owner-test-'))
  owner = new RuntimePayloadTransfers(root)
  leases = new ApplicationCallerLeaseRegistry()
})
afterEach(async () => {
  leases.dispose()
  await owner.settleReleased()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('removes abandoned private transfer roots but preserves live and unrecognized directories', async () => {
  const uid = process.getuid?.() ?? 0
  const id = '82cce2d6-c6b8-438b-ae75-8e9d90adf446'
  const stale = `open-science-payload-${uid}-987654-${id}-ABC123`
  const live = `open-science-payload-${uid}-${process.pid}-${id}-DEF456`
  const unrelated = `open-science-payload-${uid}-unrecognized`
  for (const directory of [stale, live, unrelated]) {
    await mkdir(join(root, directory))
    await writeFile(join(root, directory, 'snapshot'), 'private bytes')
  }
  const probe = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(signal).toBe(0)
    if (pid === 987654) throw Object.assign(new Error('exited'), { code: 'ESRCH' })
    return probe(pid, signal)
  })
  const client = caller()
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 1 })
  )
  await client.invoke('sessions:save-session', [], {
    kind: 'release',
    snapshotId: $payload.snapshotId
  })
  expect((await readdir(root)).sort()).toEqual([live, unrelated].sort())
})
function caller(id = 'document'): {
  dispatch: Mock<(args: readonly unknown[]) => Promise<unknown>>
  revoke(): void
  invoke(
    channel: string,
    args?: readonly unknown[],
    transfer?: RuntimePayloadRequest
  ): Promise<unknown>
} {
  let authorized = true
  const context = createWebCallerContext(id, { isAuthorizationCurrent: () => authorized })
  const { lease } = leases.acquire(context)
  const dispatch = vi.fn(async (args: readonly unknown[]): Promise<unknown> => args)
  return {
    dispatch,
    revoke: () => {
      authorized = false
    },
    invoke: (channel: string, args: readonly unknown[] = [], transfer?: RuntimePayloadRequest) =>
      owner.invoke(channel, args, context, lease, { acceptPayload: 1, transfer }, dispatch)
  }
}

it('keeps one immutable snapshot and reconstructs all Unicode bytes in order', async () => {
  const client = caller()
  const result = { text: '科学\u0000😀'.repeat(600_000), revision: 12 }
  client.dispatch.mockResolvedValue(result)
  const descriptor = runtimePayloadDescriptorSchema.parse(await client.invoke('sessions:load-one'))
  const expected = JSON.stringify(result)
  result.text = 'new revision'
  const parts: Buffer[] = []
  let offset = 0
  while (offset < descriptor.$payload.byteLength) {
    const page = (await client.invoke('sessions:load-one', [], {
      kind: 'read',
      snapshotId: descriptor.$payload.snapshotId,
      offset
    })) as { data: string; nextOffset: number; offset: number }
    const bytes = Buffer.from(page.data, 'base64')
    expect(bytes.length).toBeLessThanOrEqual(1024 * 1024)
    expect(page.offset).toBe(offset)
    expect(page.nextOffset).toBe(offset + bytes.length)
    offset = page.nextOffset
    parts.push(bytes)
  }
  expect(Buffer.concat(parts).toString()).toBe(expected)
  expect(client.dispatch).toHaveBeenCalledOnce()
  const [directory] = await readdir(root)
  if (process.platform !== 'win32') {
    expect((await stat(join(root, directory))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, directory, descriptor.$payload.snapshotId))).mode & 0o777).toBe(
      0o600
    )
  }
  await client.invoke('sessions:load-one', [], {
    kind: 'release',
    snapshotId: descriptor.$payload.snapshotId
  })
  expect(await readdir(root)).toEqual([])
})

it('does not invoke a mutation until an upload is complete and committed once', async () => {
  const client = caller()
  const bytes = Buffer.from(JSON.stringify([{ revision: 5, messages: ['α😀'] }]))
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: bytes.length })
  )
  expect(client.dispatch).not.toHaveBeenCalled()
  await client.invoke('sessions:save-session', [], {
    kind: 'append',
    snapshotId: $payload.snapshotId,
    offset: 0,
    data: bytes.toString('base64')
  })
  expect(client.dispatch).not.toHaveBeenCalled()
  await expect(
    client.invoke('sessions:save-session', [], { kind: 'commit', snapshotId: $payload.snapshotId })
  ).resolves.toEqual(JSON.parse(bytes.toString()))
  await expect(
    client.invoke('sessions:save-session', [], { kind: 'commit', snapshotId: $payload.snapshotId })
  ).rejects.toThrow('no longer available')
  expect(client.dispatch).toHaveBeenCalledOnce()
  expect(await readdir(root)).toEqual([])
})

it('rejects incomplete uploads and never invokes or leaves their temporary files', async () => {
  const client = caller()
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 10 })
  )
  await expect(
    client.invoke('sessions:save-session', [], { kind: 'commit', snapshotId: $payload.snapshotId })
  ).rejects.toThrow('incomplete')
  expect(client.dispatch).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('binds tokens to their document lease, command and current authorization', async () => {
  const client = caller('a')
  const foreign = caller('b')
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 10 })
  )
  const release = { kind: 'release' as const, snapshotId: $payload.snapshotId }
  await expect(foreign.invoke('sessions:save-session', [], release)).rejects.toThrow(
    'no longer available'
  )
  await expect(client.invoke('sessions:load-one', [], release)).rejects.toThrow(
    'no longer available'
  )
  client.revoke()
  await expect(client.invoke('sessions:save-session', [], release)).rejects.toThrow(
    'no longer authorized'
  )
  leases.dispose()
  await owner.settleReleased()
  expect(await readdir(root)).toEqual([])
})

it('rejects malformed base64 and invalid offsets without accepting partial saves', async () => {
  for (const request of [
    { offset: 1, data: 'eA==' },
    { offset: 0, data: 'eA==garbage' }
  ]) {
    const client = caller()
    const { $payload } = runtimePayloadDescriptorSchema.parse(
      await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 10 })
    )
    await expect(
      client.invoke('sessions:save-session', [], {
        kind: 'append',
        snapshotId: $payload.snapshotId,
        ...request
      })
    ).rejects.toThrow('Invalid payload upload page')
    expect(client.dispatch).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  }
})

it('reserves the global byte quota before creating an upload file and releases it on cancellation', async () => {
  const a = caller('a'),
    b = caller('b'),
    c = caller('c')
  const first = runtimePayloadDescriptorSchema.parse(
    await a.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 512 * 1024 * 1024 })
  )
  await b.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 512 * 1024 * 1024 })
  await expect(
    c.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 1 })
  ).rejects.toThrow('byte budget')
  const [directory] = await readdir(root)
  expect(await readdir(join(root, directory))).toHaveLength(2)
  await a.invoke('sessions:save-session', [], {
    kind: 'release',
    snapshotId: first.$payload.snapshotId
  })
  await expect(
    c.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 512 * 1024 * 1024 })
  ).resolves.toHaveProperty('$payload')
})

it('bounds process-wide admissions including pending transfers for the same document', async () => {
  const clients = Array.from({ length: 5 }, (_, index) => caller(String(index)))
  for (const client of clients.slice(0, 4))
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 1 })
  await expect(
    clients[0].invoke('sessions:save-session', [], { kind: 'upload', byteLength: 1 })
  ).rejects.toThrow('capacity')
  await expect(
    clients[4].invoke('sessions:save-session', [], { kind: 'upload', byteLength: 1 })
  ).rejects.toThrow('capacity')
  expect(clients[4].dispatch).not.toHaveBeenCalled()
})

it('queues concurrent large reads for one document while retaining only one active file', async () => {
  const client = caller()
  client.dispatch.mockResolvedValue({ text: 'x'.repeat(9 * 1024 * 1024) })
  const first = runtimePayloadDescriptorSchema.parse(await client.invoke('sessions:load-one'))
  const second = client.invoke('sessions:load-one')
  const [directory] = await readdir(root)
  expect(await readdir(join(root, directory))).toEqual([first.$payload.snapshotId])
  await client.invoke('sessions:load-one', [], {
    kind: 'release',
    snapshotId: first.$payload.snapshotId
  })
  const next = runtimePayloadDescriptorSchema.parse(await second)
  expect(next.$payload.snapshotId).not.toBe(first.$payload.snapshotId)
  expect(await readdir(join(root, directory))).toEqual([next.$payload.snapshotId])
})

it('cancels both active and waiting document transfers when its lease ends', async () => {
  const client = caller()
  await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 2 })
  const pending = client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 2 })
  const outcome = expect(pending).rejects.toThrow('no longer authorized')
  leases.dispose()
  await outcome
  await owner.settleReleased()
  expect(client.dispatch).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('enforces the absolute lifetime even while upload pages keep the idle timer alive', async () => {
  vi.useFakeTimers()
  const client = caller()
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 20 })
  )
  for (let offset = 0; offset < 7; offset++) {
    await vi.advanceTimersByTimeAsync(40_000)
    await client.invoke('sessions:save-session', [], {
      kind: 'append',
      snapshotId: $payload.snapshotId,
      offset,
      data: 'eA=='
    })
  }
  await vi.advanceTimersByTimeAsync(20_000)
  await owner.settleReleased()
  await expect(
    client.invoke('sessions:save-session', [], { kind: 'commit', snapshotId: $payload.snapshotId })
  ).rejects.toThrow('no longer available')
  expect(client.dispatch).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('expires idle uploads without committing them', async () => {
  vi.useFakeTimers()
  const client = caller()
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 2 })
  )
  await vi.advanceTimersByTimeAsync(60_000)
  await owner.settleReleased()
  await expect(
    client.invoke('sessions:save-session', [], {
      kind: 'append',
      snapshotId: $payload.snapshotId,
      offset: 0,
      data: 'eA=='
    })
  ).rejects.toThrow('no longer available')
  expect(client.dispatch).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('keeps small read results available when the temporary transfer quota is full', async () => {
  for (let index = 0; index < 4; index++)
    await caller(String(index)).invoke('sessions:save-session', [], {
      kind: 'upload',
      byteLength: 1
    })
  const reader = caller('small-read')
  reader.dispatch.mockResolvedValue({ id: 'small' })
  await expect(reader.invoke('sessions:load-one')).resolves.toEqual({ id: 'small' })
})
