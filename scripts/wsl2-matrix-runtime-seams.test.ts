import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  acquireAtomicGlobalFence,
  captureCleanupFailure,
  exactTerminationProgram,
  reconcileDurableProcessIdentity,
  removeOwnedGuestRoot,
  withEarlyCleanupResult
} from './wsl2-matrix-runtime-seams'

describe('WSL2 matrix executable runtime seams', () => {
  const directoryIdentity = { device: '1', inode: '2', birthTimeSeconds: '3' }
  it('claims an atomic fence and replaces heartbeat without changing immutable identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-science-atomic-fence-'))
    const fence = acquireAtomicGlobalFence(directory)
    const lock = join(directory, 'global-owner.lock')
    const identity = readFileSync(join(lock, 'owner.json'), 'utf8')
    try {
      fence.heartbeat()
      expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe(identity)
      expect(JSON.parse(readFileSync(join(lock, 'heartbeat.json'), 'utf8')).token).toBe(fence.token)
    } finally {
      fence.release()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers a release quarantine after owner evidence inside it was partly deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-science-release-retry-'))
    const fence = acquireAtomicGlobalFence(directory, {
      beforeReleaseRemove: (quarantine) => {
        unlinkSync(join(quarantine, 'owner.json'))
        throw new Error('injected partial recursive removal')
      }
    })
    expect(() => fence.release()).toThrow('injected partial recursive removal')

    const recovered = acquireAtomicGlobalFence(directory)
    expect(recovered.token).not.toBe(fence.token)
    recovered.release()
    expect(
      readdirSync(directory).filter((name) => name.startsWith('global-owner.release-'))
    ).toEqual([])
    rmSync(directory, { recursive: true, force: true })
  })

  it('does not touch an active replacement while recovering an old release quarantine', () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-science-release-replacement-'))
    const fence = acquireAtomicGlobalFence(directory, {
      beforeReleaseRemove: () => {
        const replacement = join(directory, 'global-owner.lock')
        mkdirSync(replacement)
        writeFileSync(
          join(replacement, 'owner.json'),
          JSON.stringify({ token: 'replacement', pid: process.pid })
        )
        writeFileSync(
          join(replacement, 'heartbeat.json'),
          JSON.stringify({ token: 'replacement', heartbeatAtMs: Date.now() })
        )
        throw new Error('injected replacement race')
      }
    })
    expect(() => fence.release()).toThrow('injected replacement race')
    expect(() => acquireAtomicGlobalFence(directory)).toThrow('WSL_MATRIX_GLOBAL_OWNER_ACTIVE')
    expect(
      JSON.parse(readFileSync(join(directory, 'global-owner.lock', 'owner.json'), 'utf8')).token
    ).toBe('replacement')
    rmSync(directory, { recursive: true, force: true })
  })

  it('does not delete a replacement swapped into the release delete path after verification', () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-science-release-delete-race-'))
    let replacementPath = ''
    const fence = acquireAtomicGlobalFence(directory, {
      beforeReleaseRemove: (deletingPath) => {
        renameSync(deletingPath, `${deletingPath}.owned`)
        mkdirSync(deletingPath)
        writeFileSync(join(deletingPath, 'replacement.json'), '{"owner":"replacement"}')
        replacementPath = deletingPath
      }
    })
    expect(() => fence.release()).toThrow('WSL_MATRIX_GLOBAL_RELEASE_IDENTITY_MISMATCH')
    expect(readFileSync(join(replacementPath, 'replacement.json'), 'utf8')).toContain('replacement')
    expect(() => acquireAtomicGlobalFence(directory)).toThrow(
      'WSL_MATRIX_GLOBAL_RELEASE_IDENTITY_MISMATCH'
    )
    expect(readFileSync(join(replacementPath, 'replacement.json'), 'utf8')).toContain('replacement')
    rmSync(directory, { recursive: true, force: true })
  })

  it('preserves a quarantined root without touching a replacement canonical marker', async () => {
    const events: string[] = []
    await expect(
      removeOwnedGuestRoot({
        rootExists: () => true,
        quarantineExists: () => false,
        readCanonicalIdentity: () => directoryIdentity,
        canonicalIdentityMatches: () => true,
        quarantineIdentityMatches: () => true,
        removePreparingRoot: () => true,
        persistTransition: (phase) => {
          events.push(`persist:${phase}`)
          return true
        },
        clearTransition: () => {
          events.push('clear')
          return true
        },
        quarantine: () => {
          events.push('quarantine')
          return true
        },
        markerMatchesCanonical: () => {
          events.push('verify-canonical')
          return false
        },
        markerMatchesInQuarantine: () => false,
        removeQuarantine: () => {
          events.push('remove')
          return true
        }
      })
    ).resolves.toBe(false)
    expect(events).toEqual(['verify-canonical'])
  })

  it('retries an externally verified quarantine after its internal marker was partly deleted', async () => {
    const events: string[] = []
    let firstRemoval = true
    const operations = {
      rootExists: () => true,
      quarantineExists: () => !firstRemoval,
      readCanonicalIdentity: () => directoryIdentity,
      canonicalIdentityMatches: () => true,
      quarantineIdentityMatches: () => true,
      removePreparingRoot: () => true,
      persistTransition: (phase: 'prepared' | 'verified') => {
        events.push(`persist:${phase}`)
        return true
      },
      clearTransition: () => {
        events.push('clear')
        return true
      },
      quarantine: () => true,
      markerMatchesCanonical: () => true,
      markerMatchesInQuarantine: () => {
        events.push('verify-marker')
        return true
      },
      removeQuarantine: () => {
        events.push('remove')
        if (firstRemoval) {
          firstRemoval = false
          return false
        }
        return true
      }
    }

    await expect(removeOwnedGuestRoot(operations)).resolves.toBe(false)
    await expect(
      removeOwnedGuestRoot(operations, { phase: 'verified', identity: directoryIdentity })
    ).resolves.toBe(true)
    expect(events).toEqual([
      'persist:prepared',
      'verify-marker',
      'persist:verified',
      'remove',
      'remove',
      'clear'
    ])
  })

  it('clears a verified transition without moving a replacement canonical root', async () => {
    const events: string[] = []
    await expect(
      removeOwnedGuestRoot(
        {
          rootExists: () => {
            throw new Error('replacement canonical must not be inspected or moved')
          },
          quarantineExists: () => false,
          readCanonicalIdentity: () => directoryIdentity,
          canonicalIdentityMatches: () => true,
          quarantineIdentityMatches: () => true,
          removePreparingRoot: () => true,
          persistTransition: () => true,
          clearTransition: () => {
            events.push('clear')
            return true
          },
          quarantine: () => {
            events.push('quarantine')
            return true
          },
          markerMatchesCanonical: () => false,
          markerMatchesInQuarantine: () => false,
          removeQuarantine: () => true
        },
        { phase: 'verified', identity: directoryIdentity }
      )
    ).resolves.toBe(true)
    expect(events).toEqual(['clear'])
  })

  it.each([
    ['quarantine replacement', true],
    ['prepared canonical replacement', false]
  ])('preserves a %s when its directory identity differs', async (_name, quarantineExists) => {
    const events: string[] = []
    await expect(
      removeOwnedGuestRoot(
        {
          rootExists: () => true,
          quarantineExists: () => quarantineExists,
          readCanonicalIdentity: () => directoryIdentity,
          canonicalIdentityMatches: () => false,
          quarantineIdentityMatches: () => false,
          removePreparingRoot: () => true,
          persistTransition: () => true,
          clearTransition: () => true,
          quarantine: () => {
            events.push('quarantine')
            return true
          },
          markerMatchesCanonical: () => true,
          markerMatchesInQuarantine: () => true,
          removeQuarantine: () => {
            events.push('remove')
            return true
          }
        },
        { phase: 'prepared', identity: directoryIdentity }
      )
    ).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('classifies each identity immediately before each production signal phase', () => {
    expect(exactTerminationProgram).toContain('signal_phase TERM || exit $?')
    expect(exactTerminationProgram).toContain('signal_phase KILL || exit $?')
    expect(exactTerminationProgram).not.toContain('alive_identities=')
    const phase = exactTerminationProgram.slice(
      exactTerminationProgram.indexOf('signal_phase()'),
      exactTerminationProgram.indexOf('signal_phase TERM')
    )
    expect(phase.indexOf('verify_identity')).toBeLessThan(phase.indexOf('kill "-$signal"'))
    expect(phase).toContain('[ "$verified" -eq 1 ] && continue')
  })

  it.each(['stopped', 'absent', 'mismatch'] as const)(
    'routes a complete missing-receipt identity through production termination: %s',
    (outcome) => {
      const identity = {
        token: 'owned-token',
        receiptPath: '/owned.receipt',
        completionPath: '/owned.receipt.completion',
        leaderPid: 42,
        startTimeTicks: '10',
        sid: 42,
        pgid: 42
      }
      let terminated = false
      expect(
        reconcileDurableProcessIdentity(identity, {
          receiptExists: () => false,
          pendingCompletionProvesStopped: () => {
            throw new Error('complete identity must not consult pending completion proof')
          },
          capturePendingReceipt: () => {
            throw new Error('complete identity must not recapture a missing receipt')
          },
          terminateComplete: (target) => {
            terminated = target === identity
            return outcome
          }
        })
      ).toBe(outcome)
      expect(terminated).toBe(true)
    }
  )

  it('captures cleanup rejection as a stable structured failure name', async () => {
    const failures: string[] = []
    await expect(
      captureCleanupFailure(failures, 'gateway-close', async () => {
        throw new Error('private transport detail')
      })
    ).resolves.toBe(false)
    expect(failures).toEqual(['gateway-close'])
  })

  it('upgrades an unsupported early result when global-fence release fails', () => {
    expect(
      withEarlyCleanupResult(
        { schemaVersion: 1, status: 'unsupported', capabilities: { bubblewrap: false } },
        ['global-fence-release']
      )
    ).toEqual({
      schemaVersion: 1,
      status: 'failed',
      capabilities: { bubblewrap: false },
      errorCode: 'WSL_MATRIX_CLEANUP_INCOMPLETE',
      cleanupFailures: ['global-fence-release']
    })
  })
})
