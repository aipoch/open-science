import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DURABLE_OWNERSHIP_SCHEMA_VERSION,
  canonicalDurableGuestRoot,
  canonicalDurableOwnerToken,
  canonicalDurableReceiptPath,
  durableOwnershipJournalPath,
  listDurableOwnership,
  parseDurableOwnershipRecord,
  persistDurableOwnership,
  reconcileDurableOwnership,
  updateDurableOwnership,
  type DurableOwnershipOperations,
  type DurableOwnershipRecord
} from './wsl2-matrix-durable-owner'
import { reconcileDurableProcessIdentity } from './wsl2-matrix-runtime-seams'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function journalDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'open-science-wsl2-owner-test-'))
  roots.push(root)
  return join(root, 'app-owned-journals')
}

function record(runId = 'run-42'): DurableOwnershipRecord {
  const guestRoot = canonicalDurableGuestRoot(runId)
  return {
    schemaVersion: DURABLE_OWNERSHIP_SCHEMA_VERSION,
    runId,
    distro: 'Ubuntu-24.04',
    user: 'matrix-user',
    guestRoot,
    ownerToken: canonicalDurableOwnerToken(runId, 'abc123'),
    leaseId: `lease-${runId}`,
    heartbeatAtMs: 0,
    phase: 'running',
    guestRootTransition: null,
    preparingRootIdentity: null,
    processes: [
      {
        token: 'opaque process one',
        receiptPath: canonicalDurableReceiptPath(runId, 'opaque process one'),
        completionPath: `${canonicalDurableReceiptPath(runId, 'opaque process one')}.completion`,
        leaderPid: 101,
        startTimeTicks: '7001',
        sid: 101,
        pgid: 101,
        descendants: []
      },
      {
        token: 'opaque/process/two',
        receiptPath: canonicalDurableReceiptPath(runId, 'opaque/process/two'),
        completionPath: `${canonicalDurableReceiptPath(runId, 'opaque/process/two')}.completion`,
        leaderPid: null,
        startTimeTicks: null,
        sid: null,
        pgid: null,
        descendants: []
      }
    ]
  }
}

function operations(events: string[]): DurableOwnershipOperations {
  return {
    proveOwnership: async () => {
      events.push('prove')
      return true
    },
    stopProcess: async (identity) => {
      events.push(`stop:${identity.token}`)
      return true
    },
    removeGuestRoot: async () => {
      events.push('remove-root')
      return true
    }
  }
}

describe('WSL2 matrix durable ownership', () => {
  it('persists and updates a strict run-bound journal through atomic replacement', async () => {
    const directory = await journalDirectory()
    const created = await persistDurableOwnership(record(), { directory })
    const updated = await updateDurableOwnership(
      'run-42',
      (current) => ({
        ...current,
        processes: current.processes.slice(0, 1),
        guestRootTransition: {
          quarantinePath: `${current.guestRoot}.quarantine-${current.ownerToken}`,
          ownerToken: current.ownerToken,
          phase: 'verified',
          identity: { device: '1', inode: '2', birthTimeSeconds: '3' }
        }
      }),
      { directory }
    )

    expect(updated.path).toBe(created.path)
    expect(JSON.parse(await readFile(created.path, 'utf8')).processes).toHaveLength(1)
    expect(updated.record.guestRootTransition?.phase).toBe('verified')
    expect((await listDurableOwnership({ directory })).valid[0]?.record).toEqual(updated.record)
  })

  it.each([
    ['foreign guest root', { guestRoot: '/tmp/open-science-wsl2-matrix-other-run' }],
    ['foreign owner token', { ownerToken: 'other-run:owner:abc123' }],
    [
      'foreign process token',
      {
        processes: [
          {
            token: 'opaque',
            receiptPath: '/tmp/open-science-wsl2-matrix-other-run/receipts/opaque.receipt',
            completionPath:
              '/tmp/open-science-wsl2-matrix-other-run/receipts/opaque.receipt.completion',
            leaderPid: null,
            startTimeTicks: null,
            sid: null,
            pgid: null,
            descendants: []
          }
        ]
      }
    ],
    [
      'receipt outside the guest root',
      {
        processes: [
          {
            token: 'opaque',
            receiptPath: '/tmp/open-science-wsl2-matrix-run-42-foreign/receipts/opaque.receipt',
            completionPath:
              '/tmp/open-science-wsl2-matrix-run-42-foreign/receipts/opaque.receipt.completion',
            leaderPid: null,
            startTimeTicks: null,
            sid: null,
            pgid: null,
            descendants: []
          }
        ]
      }
    ]
  ])('rejects a %s', (_label, replacement) => {
    expect(() => parseDurableOwnershipRecord({ ...record(), ...replacement })).toThrow(/invalid/i)
  })

  it('rejects a partially captured process identity', () => {
    const invalid = record()
    invalid.processes[0] = { ...invalid.processes[0]!, pgid: null }
    expect(() => parseDurableOwnershipRecord(invalid)).toThrow(/incomplete/i)
  })

  it.each(['preparing', 'launching', 'running'] as const)(
    'persists the explicit %s recovery phase',
    (phase) => {
      expect(parseDurableOwnershipRecord({ ...record(), phase }).phase).toBe(phase)
    }
  )

  it('rejects a journal without an explicit recovery phase', () => {
    const missingPhase: Partial<DurableOwnershipRecord> = { ...record() }
    delete missingPhase.phase
    expect(() => parseDurableOwnershipRecord(missingPhase)).toThrow(/shape/i)
  })

  it('stops every recorded process before removing the guest root and journal', async () => {
    const directory = await journalDirectory()
    const journal = await persistDurableOwnership(record(), { directory })
    const events: string[] = []

    await expect(reconcileDurableOwnership(operations(events), { directory })).resolves.toEqual([
      { status: 'cleaned', path: journal.path, runId: 'run-42' }
    ])
    expect(events).toEqual([
      'prove',
      'stop:opaque process one',
      'stop:opaque/process/two',
      'remove-root'
    ])
    expect(await listDurableOwnership({ directory })).toEqual({ valid: [], invalid: [] })
  })

  it('preserves a concurrently active lease without invoking cleanup', async () => {
    const directory = await journalDirectory()
    const active = { ...record('run-active'), heartbeatAtMs: 50_000 }
    const journal = await persistDurableOwnership(active, { directory })
    const stopProcess = vi.fn()
    const removeGuestRoot = vi.fn()

    const result = await reconcileDurableOwnership(
      {
        proveOwnership: async () => true,
        stopProcess,
        removeGuestRoot
      },
      { directory, nowMs: 55_000, activeLeaseTimeoutMs: 10_000 }
    )

    expect(result).toEqual([
      { status: 'preserved-active', path: journal.path, runId: 'run-active' }
    ])
    expect(stopProcess).not.toHaveBeenCalled()
    expect(removeGuestRoot).not.toHaveBeenCalled()
  })

  it('keeps an interrupted cleanup journal and retries it idempotently on startup', async () => {
    const directory = await journalDirectory()
    const journal = await persistDurableOwnership(record(), { directory })
    const events: string[] = []
    let firstAttempt = true
    const injected = operations(events)
    injected.stopProcess = vi.fn(async (identity) => {
      events.push(`stop:${identity.token}`)
      if (firstAttempt && identity.token.endsWith('/two')) {
        firstAttempt = false
        throw new Error('WSL stopped responding')
      }
      return true
    })

    const interrupted = await reconcileDurableOwnership(injected, { directory })
    expect(interrupted[0]).toMatchObject({
      status: 'preserved-retryable',
      path: journal.path,
      runId: 'run-42'
    })
    await expect(readFile(journal.path, 'utf8')).resolves.toContain('run-42')

    const retried = await reconcileDurableOwnership(injected, { directory })
    expect(retried).toEqual([{ status: 'cleaned', path: journal.path, runId: 'run-42' }])
    expect(events.filter((event) => event === 'stop:opaque process one')).toHaveLength(2)
    expect(events.at(-1)).toBe('remove-root')

    await expect(reconcileDurableOwnership(injected, { directory })).resolves.toEqual([])
  })

  it.each(['root-present-missing-receipt', 'root-absent-without-completion-proof'])(
    'preserves %s across repeated reconciliation without removing the root',
    async () => {
      const directory = await journalDirectory()
      const journal = await persistDurableOwnership(record(), { directory })
      const removeGuestRoot = vi.fn()
      const operations: DurableOwnershipOperations = {
        proveOwnership: async () => true,
        stopProcess: async () => false,
        removeGuestRoot
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(reconcileDurableOwnership(operations, { directory })).resolves.toMatchObject([
          { status: 'preserved-retryable', path: journal.path }
        ])
      }
      expect(removeGuestRoot).not.toHaveBeenCalled()
      await expect(readFile(journal.path, 'utf8')).resolves.toContain('run-42')
    }
  )

  it('preserves unowned and invalid journals without invoking destructive operations', async () => {
    const directory = await journalDirectory()
    const unowned = await persistDurableOwnership(record('run-unowned'), { directory })
    const invalidPath = durableOwnershipJournalPath('run-invalid', { directory })
    await writeFile(invalidPath, '{ definitely not json', 'utf8')
    const stopProcess = vi.fn()
    const removeGuestRoot = vi.fn()

    const results = await reconcileDurableOwnership(
      {
        proveOwnership: async () => false,
        stopProcess: async (...args) => {
          stopProcess(...args)
          return true
        },
        removeGuestRoot: async (...args) => {
          removeGuestRoot(...args)
          return true
        }
      },
      { directory }
    )

    expect(results.map(({ status }) => status).sort()).toEqual([
      'preserved-invalid',
      'preserved-unowned'
    ])
    expect(stopProcess).not.toHaveBeenCalled()
    expect(removeGuestRoot).not.toHaveBeenCalled()
    await expect(readFile(unowned.path, 'utf8')).resolves.toContain('run-unowned')
    await expect(readFile(invalidPath, 'utf8')).resolves.toBe('{ definitely not json')
  })

  it('reports and preserves an interrupted atomic-write residue', async () => {
    const directory = await journalDirectory()
    const residue = join(directory, 'run-atomic.json.nonce.tmp')
    await persistDurableOwnership(record(), { directory })
    await writeFile(residue, JSON.stringify(record()), 'utf8')

    const listing = await listDurableOwnership({ directory })
    expect(listing.invalid.map(({ path }) => path)).toContain(residue)
    const results = await reconcileDurableOwnership(operations([]), { directory })
    expect(
      results.some(({ status, path }) => status === 'preserved-invalid' && path === residue)
    ).toBe(true)
    await expect(readFile(residue, 'utf8')).resolves.toContain('run-42')
  })

  it('retains the journal when guest-root removal fails after every stop', async () => {
    const directory = await journalDirectory()
    const journal = await persistDurableOwnership(record(), { directory })
    const events: string[] = []
    const injected = operations(events)
    injected.removeGuestRoot = async () => {
      events.push('remove-root')
      throw new Error('remove failed')
    }

    const result = await reconcileDurableOwnership(injected, { directory })
    expect(result[0]).toMatchObject({ status: 'preserved-retryable', path: journal.path })
    expect(events).toEqual([
      'prove',
      'stop:opaque process one',
      'stop:opaque/process/two',
      'remove-root'
    ])
    await expect(readFile(journal.path, 'utf8')).resolves.toContain('run-42')
  })

  it('retries self-clean after a token-bound pending STOPPED proof instead of orphaning the run', async () => {
    const directory = await journalDirectory()
    const pending = record().processes[1]!
    const journal = await persistDurableOwnership(
      { ...record(), processes: [pending] },
      { directory }
    )
    let rootRemovalAttempts = 0
    const injected: DurableOwnershipOperations = {
      proveOwnership: async () => true,
      stopProcess: async (identity) =>
        reconcileDurableProcessIdentity(identity, {
          receiptExists: () => false,
          pendingCompletionProvesStopped: () => true,
          capturePendingReceipt: () => undefined,
          terminateComplete: () => 'failed'
        }) === 'stopped',
      removeGuestRoot: async () => ++rootRemovalAttempts > 1
    }

    await expect(reconcileDurableOwnership(injected, { directory })).resolves.toEqual([
      expect.objectContaining({ status: 'preserved-retryable', path: journal.path })
    ])
    await expect(readFile(journal.path, 'utf8')).resolves.toContain('run-42')
    await expect(reconcileDurableOwnership(injected, { directory })).resolves.toEqual([
      expect.objectContaining({ status: 'cleaned', path: journal.path })
    ])
    expect(rootRemovalAttempts).toBe(2)
  })
})
