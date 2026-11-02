import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { RuntimePayloadTransfers } from './runtime-payload-transfers'
import { ApplicationCallerLeaseRegistry } from './caller-lifecycle'
import { createWebCallerContext } from './caller-context'
import {
  RUNTIME_PAYLOAD_PAGE_BYTES,
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
function caller(
  id = 'document',
  acceptPayload = true
): {
  dispatch: Mock<(args: readonly unknown[]) => Promise<unknown>>
  revoke(): void
  disconnect(): void
  invoke(
    channel: string,
    args?: readonly unknown[],
    transfer?: RuntimePayloadRequest
  ): Promise<unknown>
} {
  let authorized = true
  const context = createWebCallerContext(id, { isAuthorizationCurrent: () => authorized })
  const { lease, release } = leases.acquire(context)
  const dispatch = vi.fn(async (args: readonly unknown[]): Promise<unknown> => args)
  return {
    dispatch,
    disconnect: release,
    revoke: () => {
      authorized = false
    },
    invoke: (channel: string, args: readonly unknown[] = [], transfer?: RuntimePayloadRequest) =>
      owner.invoke(
        channel,
        args,
        context,
        lease,
        { acceptPayload: acceptPayload ? 1 : undefined, transfer },
        dispatch
      )
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

it('queues large reads behind retained snapshots in FIFO order without blocking pages or small reads', async () => {
  const result = { text: 'x'.repeat(9 * 1024 * 1024) }
  const active = Array.from({ length: 4 }, (_, index) => caller(`snapshot-${index}`))
  const snapshots = []
  for (const client of active) {
    client.dispatch.mockResolvedValue(result)
    snapshots.push(runtimePayloadDescriptorSchema.parse(await client.invoke('sessions:load-one')))
  }
  const waiting = [caller('waiting-first'), caller('waiting-second')]
  const completed: number[] = []
  const pending = waiting.map((client, index) => {
    client.dispatch.mockResolvedValue(result)
    return client.invoke('notebook:state').then((value) => {
      completed.push(index)
      return runtimePayloadDescriptorSchema.parse(value)
    })
  })
  const outcomes = Promise.allSettled(pending)
  try {
    await vi.waitFor(() => expect(waiting[1].dispatch).toHaveBeenCalledOnce())
    const small = caller('small-while-snapshots-retained')
    small.dispatch.mockResolvedValue({ id: 'small' })
    await expect(small.invoke('sessions:load-one')).resolves.toEqual({ id: 'small' })
    await expect(
      active[0].invoke('sessions:load-one', [], {
        kind: 'read',
        snapshotId: snapshots[0].$payload.snapshotId,
        offset: 0
      })
    ).resolves.toMatchObject({ nextOffset: RUNTIME_PAYLOAD_PAGE_BYTES })
    await active[0].invoke('sessions:load-one', [], {
      kind: 'release',
      snapshotId: snapshots[0].$payload.snapshotId
    })
    const first = await pending[0]
    expect(completed).toEqual([0])
    await waiting[0].invoke('notebook:state', [], {
      kind: 'release',
      snapshotId: first.$payload.snapshotId
    })
    await pending[1]
    expect(completed).toEqual([0, 1])
  } finally {
    leases.dispose()
    await outcomes
  }
})

it('cancels a large read waiting for snapshot capacity when its document disconnects', async () => {
  const active = Array.from({ length: 4 }, (_, index) => caller(`upload-${index}`))
  for (const client of active)
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 1 })
  const waiting = caller('cancelled-read')
  waiting.dispatch.mockResolvedValue({ text: 'x'.repeat(9 * 1024 * 1024) })
  const pending = waiting.invoke('sessions:load-one')
  const outcome = Promise.allSettled([pending])
  await vi.waitFor(() => expect(waiting.dispatch).toHaveBeenCalledOnce())
  waiting.disconnect()
  await expect(pending).rejects.toThrow('no longer authorized')
  await outcome
})

it('waits for enough byte capacity in FIFO order even when a snapshot slot is free', async () => {
  const active = [caller('byte-budget-a'), caller('byte-budget-b'), caller('byte-budget-c')]
  const snapshots = []
  for (const [index, client] of active.entries())
    snapshots.push(
      runtimePayloadDescriptorSchema.parse(
        await client.invoke('sessions:save-session', [], {
          kind: 'upload',
          byteLength: [512, 496, 16][index] * 1024 * 1024
        })
      )
    )
  const first = caller('large-byte-waiter')
  const second = caller('smaller-byte-waiter')
  first.dispatch.mockResolvedValue({ text: 'x'.repeat(20 * 1024 * 1024) })
  second.dispatch.mockResolvedValue({ text: 'x'.repeat(9 * 1024 * 1024) })
  const completed: string[] = []
  const reads = [first, second].map((client, index) =>
    client.invoke('sessions:load-one').then((value) => {
      completed.push(index === 0 ? 'first' : 'second')
      return value
    })
  )
  const outcomes = Promise.allSettled(reads)
  try {
    await vi.waitFor(() => expect(second.dispatch).toHaveBeenCalledOnce())
    await active[2].invoke('sessions:save-session', [], {
      kind: 'release',
      snapshotId: snapshots[2].$payload.snapshotId
    })
    // The second reader could fit, but must not overtake the queue head in the sixteen MiB freed.
    expect(completed).toEqual([])
    // Probe the reservation itself: a smaller waiter overtaking the head would consume nine
    // MiB before its async snapshot publication completes, leaving too little for this upload.
    const probe = caller('byte-budget-fifo-probe')
    const probeSnapshot = runtimePayloadDescriptorSchema.parse(
      await probe.invoke('sessions:save-session', [], {
        kind: 'upload',
        byteLength: 16 * 1024 * 1024
      })
    )
    await probe.invoke('sessions:save-session', [], {
      kind: 'release',
      snapshotId: probeSnapshot.$payload.snapshotId
    })
    await active[1].invoke('sessions:save-session', [], {
      kind: 'release',
      snapshotId: snapshots[1].$payload.snapshotId
    })
    await Promise.all(reads)
    expect(completed.sort()).toEqual(['first', 'second'])
  } finally {
    leases.dispose()
    await outcomes
  }
})

it('wakes a queued large read after the retained uploads expire', async () => {
  vi.useFakeTimers()
  const active = Array.from({ length: 4 }, (_, index) => caller(`expiring-upload-${index}`))
  for (const client of active)
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 1 })
  const reader = caller('read-after-expiry')
  reader.dispatch.mockResolvedValue({ text: 'x'.repeat(9 * 1024 * 1024) })
  const pending = reader.invoke('sessions:load-one')
  const outcome = Promise.allSettled([pending])
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(pending).resolves.toHaveProperty('$payload')
    expect(reader.dispatch).toHaveBeenCalledOnce()
  } finally {
    leases.dispose()
    await outcome
  }
})

it('wakes a queued read when a committed mutation shrinks its reservation before download release', async () => {
  const result = { text: 'x'.repeat(9 * 1024 * 1024) }
  let finish!: () => void
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const mutations = [caller('shrinking-mutation'), caller('retained-reservation')]
  for (const client of mutations)
    client.dispatch.mockImplementation(async () => {
      await ready
      return result
    })
  const pendingMutations = mutations.map((client) => client.invoke('sessions:edit-details'))
  const mutationOutcomes = Promise.allSettled(pendingMutations)
  const reader = caller('read-after-shrink')
  reader.dispatch.mockResolvedValue(result)
  let completed = false
  const read = reader.invoke('sessions:load-one').then((value) => {
    completed = true
    return value
  })
  const readOutcome = Promise.allSettled([read])
  try {
    await vi.waitFor(() => expect(mutations[1].dispatch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(reader.dispatch).toHaveBeenCalledOnce())
    expect(completed).toBe(false)
    finish()
    await Promise.all(pendingMutations)
    // Both mutation snapshots remain retained; their smaller reservations alone free capacity.
    await vi.waitFor(() => expect(completed).toBe(true))
    await expect(read).resolves.toHaveProperty('$payload')
  } finally {
    finish()
    leases.dispose()
    await mutationOutcomes
    await readOutcome
  }
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

it.each(['sessions:load-one', 'notebook:state'])(
  'bounds pending %s reads before dispatch and releases admission after completion',
  async (channel) => {
    const result = { text: 'x'.repeat(9 * 1024 * 1024) }
    let finish!: () => void
    const ready = new Promise<void>((resolve) => {
      finish = resolve
    })
    const readers = Array.from({ length: 4 }, (_, i) => caller(`pending-${i}`))
    const pending = readers.map((reader, i) => {
      reader.dispatch.mockImplementation(async () => {
        await ready
        return result
      })
      return reader.invoke(i % 2 ? 'sessions:load-one' : 'notebook:state')
    })
    const settled = Promise.allSettled(pending)
    const overflow = caller('overflow')
    overflow.dispatch.mockResolvedValue({ id: 'small' })
    const waiting = overflow.invoke(channel)
    const waitingOutcome = Promise.allSettled([waiting])
    try {
      await Promise.resolve()
      expect(overflow.dispatch).not.toHaveBeenCalled()
    } finally {
      finish()
      await settled
      await waitingOutcome
    }
    await expect(waiting).resolves.toEqual({ id: 'small' })
    expect((await settled).map((outcome) => outcome.status)).toEqual(Array(4).fill('fulfilled'))
    // Retained snapshots must not consume pending-read slots or block a small subsequent read.
    overflow.dispatch.mockResolvedValue({ id: 'small' })
    await expect(overflow.invoke(channel)).resolves.toEqual({ id: 'small' })
  }
)

it('releases pending read admission after a domain failure', async () => {
  const reader = caller()
  reader.dispatch.mockRejectedValue(new Error('domain failed'))
  for (let i = 0; i < 5; i += 1)
    await expect(reader.invoke('notebook:state')).rejects.toThrow('domain failed')
  reader.dispatch.mockResolvedValue({ id: 'available' })
  await expect(reader.invoke('notebook:state')).resolves.toEqual({ id: 'available' })
})

it('bounds waiting reads, removes cancelled callers and rechecks authority before FIFO dispatch', async () => {
  let finish!: () => void
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const active = Array.from({ length: 4 }, (_, i) => caller(`active-${i}`))
  const running = Promise.allSettled(
    active.map((client) => {
      client.dispatch.mockImplementation(async () => {
        await ready
        return []
      })
      return client.invoke('sessions:load-one')
    })
  )
  const order: number[] = []
  const waiting = Array.from({ length: 32 }, (_, i) => caller(`waiting-${i}`, i % 2 === 0))
  const queued = waiting.map((client, i) => {
    client.dispatch.mockImplementation(async () => {
      order.push(i)
      return []
    })
    return client.invoke(i % 2 ? 'notebook:state' : 'sessions:load-one')
  })
  const queuedResults = Promise.allSettled(queued)
  const extra = caller('extra')
  let replacement: Promise<unknown> | undefined
  try {
    await expect(extra.invoke('sessions:load-one')).rejects.toThrow('capacity')
    expect(extra.dispatch).not.toHaveBeenCalled()
    waiting[0].disconnect()
    await expect(queued[0]).rejects.toThrow('no longer authorized')
    waiting[1].revoke()
    replacement = extra.invoke('sessions:load-one')
    active[0].disconnect()
    // Cancelling dispatched work cannot free its slot before the domain promise settles.
    await Promise.resolve()
    expect(order).toEqual([])
    expect(extra.dispatch).not.toHaveBeenCalled()
  } finally {
    finish()
    await running
    await queuedResults
    await replacement
  }
  expect((await queuedResults).map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
    ...Array(30).fill('fulfilled')
  ])
  expect(order).toEqual(Array.from({ length: 30 }, (_, i) => i + 2))
  expect(extra.dispatch).toHaveBeenCalledOnce()
  await expect(extra.invoke('notebook:state')).resolves.toEqual([])
})

it.each(['inline', 'upload'])(
  'does not expire a busy %s mutation as an idle transfer',
  async (mode) => {
    vi.useFakeTimers()
    const client = caller()
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const ready = new Promise<void>((resolve) => {
      finish = resolve
    })
    client.dispatch.mockImplementation(async () => {
      entered()
      await ready
      return { text: 'x'.repeat(9 * 1024 * 1024) }
    })
    const channel = mode === 'inline' ? 'sessions:edit-details' : 'sessions:save-session'
    let snapshotId: string | undefined
    if (mode === 'upload') {
      const descriptor = runtimePayloadDescriptorSchema.parse(
        await client.invoke(channel, [], {
          kind: 'upload',
          byteLength: 2
        })
      )
      snapshotId = descriptor.$payload.snapshotId
      await client.invoke(channel, [], { kind: 'append', snapshotId, offset: 0, data: 'W10=' })
    }
    const pending = client.invoke(
      channel,
      [],
      snapshotId ? { kind: 'commit', snapshotId } : undefined
    )
    const outcome = Promise.allSettled([pending])
    await started
    await vi.advanceTimersByTimeAsync(60_001)
    finish()
    const [settled] = await outcome
    expect(settled.status).toBe('fulfilled')
    if (settled.status !== 'fulfilled') throw settled.reason
    const result = runtimePayloadDescriptorSchema.parse(settled.value)
    expect(result.$payload.byteLength).toBeGreaterThan(9 * 1024 * 1024)
    expect(client.dispatch).toHaveBeenCalledOnce()
    // The idle clock resumes after work completes.
    await vi.advanceTimersByTimeAsync(60_001)
    await owner.settleReleased()
    await expect(
      client.invoke(channel, [], {
        kind: 'read',
        snapshotId: result.$payload.snapshotId,
        offset: 0
      })
    ).rejects.toThrow('no longer available')
  }
)

it.each(['inline', 'upload'])(
  'reserves %s mutation result capacity before dispatching domain changes',
  async (mode) => {
    const client = caller('writer')
    const channel = mode === 'inline' ? 'sessions:edit-details' : 'sessions:save-session'
    let snapshotId: string | undefined
    if (mode === 'upload') {
      const descriptor = runtimePayloadDescriptorSchema.parse(
        await client.invoke(channel, [], {
          kind: 'upload',
          byteLength: 2
        })
      )
      snapshotId = descriptor.$payload.snapshotId
      await client.invoke(channel, [], { kind: 'append', snapshotId, offset: 0, data: 'W10=' })
    }
    await caller('quota-a').invoke('sessions:save-session', [], {
      kind: 'upload',
      byteLength: 512 * 1024 * 1024
    })
    await caller('quota-b').invoke('sessions:save-session', [], {
      kind: 'upload',
      byteLength: 512 * 1024 * 1024 - (snapshotId ? 2 : 0)
    })
    let committed = false
    client.dispatch.mockImplementation(async () => {
      committed = true
      return { text: 'x'.repeat(9 * 1024 * 1024) }
    })
    await expect(
      client.invoke(channel, [], snapshotId ? { kind: 'commit', snapshotId } : undefined)
    ).rejects.toThrow('byte budget')
    expect(committed).toBe(false)
    expect(client.dispatch).not.toHaveBeenCalled()
  }
)

it('bounds shutdown cleanup when an uploaded command ignores cancellation', async () => {
  vi.useFakeTimers()
  const client = caller()
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], {
      kind: 'upload',
      byteLength: 2
    })
  )
  await client.invoke('sessions:save-session', [], {
    kind: 'append',
    snapshotId: $payload.snapshotId,
    offset: 0,
    data: 'W10='
  })
  let entered!: () => void
  let finish!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  client.dispatch.mockImplementation(async () => {
    entered()
    await ready
    return {}
  })
  const operation = Promise.allSettled([
    client.invoke('sessions:save-session', [], {
      kind: 'commit',
      snapshotId: $payload.snapshotId
    })
  ])
  await started
  leases.dispose()
  let settled = false
  const shutdown = owner.settleReleased().then(() => {
    settled = true
  })
  try {
    await vi.advanceTimersByTimeAsync(1_500)
    expect(settled).toBe(true)
  } finally {
    finish()
    await operation
    await shutdown
  }
  expect(await readdir(root)).toEqual([])
})

it('commits uploads when payload-sized buffer allocations are unavailable', async () => {
  const client = caller()
  const args = [
    {
      text:
        'x'.repeat(RUNTIME_PAYLOAD_PAGE_BYTES - 12) +
        '科学😀' +
        'x'.repeat(RUNTIME_PAYLOAD_PAGE_BYTES)
    }
  ]
  const bytes = Buffer.from(JSON.stringify(args))
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: bytes.length })
  )
  for (let offset = 0; offset < bytes.length; offset += RUNTIME_PAYLOAD_PAGE_BYTES) {
    await client.invoke('sessions:save-session', [], {
      kind: 'append',
      snapshotId: $payload.snapshotId,
      offset,
      data: bytes.subarray(offset, offset + RUNTIME_PAYLOAD_PAGE_BYTES).toString('base64')
    })
  }
  client.dispatch.mockResolvedValue(null)
  const allocate = Buffer.alloc
  vi.spyOn(Buffer, 'alloc').mockImplementation((size, ...rest) => {
    if (size > RUNTIME_PAYLOAD_PAGE_BYTES)
      throw new RangeError('Payload-sized allocation unavailable')
    return allocate(size, ...rest)
  })
  await expect(
    client.invoke('sessions:save-session', [], { kind: 'commit', snapshotId: $payload.snapshotId })
  ).resolves.toBeNull()
  expect(client.dispatch).toHaveBeenCalledExactlyOnceWith(args)
})

it('rejects exhausted mutation capacity before reading uploaded arguments', async () => {
  const client = caller('writer')
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: 2 })
  )
  await client.invoke('sessions:save-session', [], {
    kind: 'append',
    snapshotId: $payload.snapshotId,
    offset: 0,
    data: 'W10='
  })
  await caller('quota-a').invoke('sessions:save-session', [], {
    kind: 'upload',
    byteLength: 512 * 1024 * 1024
  })
  await caller('quota-b').invoke('sessions:save-session', [], {
    kind: 'upload',
    byteLength: 512 * 1024 * 1024 - 2
  })
  const allocate = vi.spyOn(Buffer, 'alloc')
  await expect(
    client.invoke('sessions:save-session', [], { kind: 'commit', snapshotId: $payload.snapshotId })
  ).rejects.toThrow('byte budget')
  expect(allocate).not.toHaveBeenCalled()
  expect(client.dispatch).not.toHaveBeenCalled()
})

it.each([
  [0x5b, 0x22, 0xe2, 0x22, 0x5d],
  [0x5b, 0x22, 0xe2]
])('rejects invalid or unfinished uploaded UTF-8 before domain dispatch: %j', async (...data) => {
  const client = caller()
  const bytes = Buffer.from(data)
  const { $payload } = runtimePayloadDescriptorSchema.parse(
    await client.invoke('sessions:save-session', [], { kind: 'upload', byteLength: bytes.length })
  )
  await client.invoke('sessions:save-session', [], {
    kind: 'append',
    snapshotId: $payload.snapshotId,
    offset: 0,
    data: bytes.toString('base64')
  })
  await expect(
    client.invoke('sessions:save-session', [], { kind: 'commit', snapshotId: $payload.snapshotId })
  ).rejects.toThrow(/encoding utf-8/)
  expect(client.dispatch).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
