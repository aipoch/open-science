import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  guestPreReceiptLauncher,
  lifecycleWrapper,
  parseMatrixArguments,
  wslArgv
} from './wsl2-network-lifecycle-matrix.js'
import {
  acquireAtomicGlobalFence,
  exactTerminationProgram,
  matrixResultErrorCode
} from './wsl2-matrix-runtime-seams.js'

describe('WSL2 real matrix launch binding', () => {
  it('requires an explicit distro and non-root user', () => {
    expect(
      parseMatrixArguments(['--distro', 'Ubuntu-22.04', '--user', 'open-science-spike'])
    ).toEqual({
      distro: 'Ubuntu-22.04',
      user: 'open-science-spike',
      crashRecoveryGate: false,
      simulateOwnerCrashAt: undefined
    })
    expect(parseMatrixArguments(['--distro', 'Ubuntu-22.04'])).toEqual({
      distro: 'Ubuntu-22.04',
      user: undefined,
      crashRecoveryGate: false,
      simulateOwnerCrashAt: undefined
    })
  })

  it('exposes an explicit repeatable crash/restart gate', () => {
    expect(
      parseMatrixArguments([
        '--distro',
        'Ubuntu-22.04',
        '--user',
        'open-science-spike',
        '--crash-recovery-gate'
      ]).crashRecoveryGate
    ).toBe(true)
  })

  it('keeps distro and user as isolated wsl.exe arguments', () => {
    expect(
      wslArgv('Ubuntu-22.04; echo injected', 'open-science-spike && whoami', [
        'bash',
        '-c',
        'printf safe'
      ])
    ).toEqual([
      '-d',
      'Ubuntu-22.04; echo injected',
      '--user',
      'open-science-spike && whoami',
      '--exec',
      'bash',
      '-c',
      'printf safe'
    ])
  })

  it('checks the current proc token before signaling a receipt PID or process group', () => {
    const identityCheck = exactTerminationProgram.indexOf(
      'grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$token"'
    )
    const firstReceiptSignal = exactTerminationProgram.indexOf('kill "-$signal"')

    expect(identityCheck).toBeGreaterThan(0)
    expect(firstReceiptSignal).toBeGreaterThan(identityCheck)
    expect(exactTerminationProgram).toContain('current_pgid=$(ps -o pgid= -p "$pid"')
    expect(exactTerminationProgram).toContain("current_start=$(awk '{print $22}'")
    expect(exactTerminationProgram).toContain('[ "$recorded_token" = "$token" ] || exit 4')
    expect(exactTerminationProgram).toContain('[ "$leader_start" = "$expected_start" ]')
    expect(exactTerminationProgram).not.toContain('/proc/[0-9]*/environ')
  })

  it('re-reads the global fence before a destructive operation can proceed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-science-fence-'))
    const fence = acquireAtomicGlobalFence(directory)
    const ownerPath = join(directory, 'global-owner.lock', 'owner.json')
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>
    try {
      writeFileSync(ownerPath, JSON.stringify({ ...owner, token: 'replacement-owner' }))

      expect(() => fence.assertOwned()).toThrow('WSL_MATRIX_FENCE_LOST')

      writeFileSync(ownerPath, JSON.stringify(owner))
      fence.release()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('uses the journal identity when an already-removed receipt is reconciled', () => {
    expect(exactTerminationProgram).toContain('receipt_descendants=$expected_descendants')
  })

  it('assigns a stable error code when cleanup evidence is incomplete', () => {
    expect(matrixResultErrorCode(false, false)).toBe('WSL_MATRIX_CLEANUP_INCOMPLETE')
    expect(matrixResultErrorCode(false, true)).toBe('WSL_MATRIX_FAILED')
    expect(matrixResultErrorCode(true, true)).toBeUndefined()
  })

  it('records the token-bearing escaped launcher as well as its grandchild', () => {
    expect(lifecycleWrapper).toContain('escaped_launcher_start=')
    expect(lifecycleWrapper).toContain(
      '"$escaped_launcher" "$escaped_launcher_start" "$escaped_launcher_sid" "$escaped_launcher_pgid" "$escaped_grandchild"'
    )
  })

  it('installs the shared fail-closed completion trap before STARTING and heartbeat validation', () => {
    const trap = guestPreReceiptLauncher.indexOf('trap pre_receipt_cleanup EXIT TERM INT HUP')
    const starting = guestPreReceiptLauncher.indexOf('write_completion STARTING')
    const heartbeat = guestPreReceiptLauncher.indexOf('heartbeat_current || exit 70')
    const stopped = guestPreReceiptLauncher.indexOf('write_completion STOPPED')

    expect(trap).toBeGreaterThan(0)
    expect(trap).toBeLessThan(starting)
    expect(starting).toBeLessThan(heartbeat)
    expect(stopped).toBeGreaterThan(0)
    expect(guestPreReceiptLauncher).toContain('kill -TERM -- "-$payload_pgid"')
    expect(guestPreReceiptLauncher).toContain('receipt_committed=1')
    expect(guestPreReceiptLauncher).toContain('trap - EXIT TERM INT HUP')
    const waitLoop = guestPreReceiptLauncher.slice(
      guestPreReceiptLauncher.indexOf('while kill -0 "$payload_pid"'),
      guestPreReceiptLauncher.indexOf('wait "$payload_pid"')
    )
    expect(waitLoop).toContain('heartbeat_current || exit 70')
    expect(guestPreReceiptLauncher).toContain('kill -TERM -- "-$payload_pgid"')
    expect(guestPreReceiptLauncher).toContain('kill -KILL -- "-$payload_pgid"')
    expect(guestPreReceiptLauncher).toContain('payload_start=$(awk')
    expect(guestPreReceiptLauncher).toContain('[ "$current_sid" = "$payload_sid" ]')
  })

  it('routes every receipt-producing guest spawn site through the shared launcher guard', () => {
    const source = readFileSync(
      new URL('./wsl2-network-lifecycle-matrix.ts', import.meta.url),
      'utf8'
    )
    expect(source.match(/\.\.\.guardedGuestCommand\(/g)).toHaveLength(4)
    expect(source.match(/write_completion STARTING/g)).toHaveLength(1)
  })

  it('does not delete a replacement owner moved by a stale-snapshot quarantine race', () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-science-fence-race-'))
    const lockPath = join(directory, 'global-owner.lock')
    const ownerPath = join(lockPath, 'owner.json')
    mkdirSync(lockPath)
    writeFileSync(ownerPath, JSON.stringify({ token: 'stale', pid: 2147483647 }))
    writeFileSync(
      join(lockPath, 'heartbeat.json'),
      JSON.stringify({ token: 'stale', heartbeatAtMs: 0 })
    )
    try {
      expect(() =>
        acquireAtomicGlobalFence(directory, {
          beforeQuarantineRename: () => {
            renameSync(lockPath, join(directory, 'observed-stale-owner'))
            mkdirSync(lockPath)
            writeFileSync(ownerPath, JSON.stringify({ token: 'replacement', pid: process.pid }))
            writeFileSync(
              join(lockPath, 'heartbeat.json'),
              JSON.stringify({ token: 'replacement', heartbeatAtMs: Date.now() })
            )
          }
        })
      ).toThrow('WSL_MATRIX_GLOBAL_OWNER_ACTIVE')
      expect(JSON.parse(readFileSync(ownerPath, 'utf8')).token).toBe('replacement')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
