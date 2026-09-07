import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerOwnedPosixProcessGroup } from '../process-tree'
import { ShellProcessOwnershipRegistry } from './shell-process-ownership.windows-posix'
import type { ChildProcess } from 'node:child_process'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>())
}))

const roots: string[] = []
const BOOT_A = '11111111-1111-4111-8111-111111111111'
const BOOT_B = '22222222-2222-4222-8222-222222222222'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(process.platform === 'linux')('Shell process ownership recovery', () => {
  it('reaps a previous app instance process group before recovery completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-process-recovery-'))
    roots.push(root)
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true })
    registerOwnedPosixProcessGroup(child)
    const firstInstance = new ShellProcessOwnershipRegistry(root)
    const release = firstInstance.claim(child, {
      runId: 'notebook-run-recovery-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      platform: process.platform
    })

    await new ShellProcessOwnershipRegistry(root).recover()

    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    release()
  })
})

describe('Shell process ownership receipt lifecycle', () => {
  const claimedReceipt = async (
    platform: NodeJS.Platform = 'linux'
  ): Promise<{ root: string; release: () => void }> => {
    const root = await mkdtemp(join(tmpdir(), 'shell-process-receipt-'))
    roots.push(root)
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true)
    }) as unknown as ChildProcess
    const registry = new ShellProcessOwnershipRegistry(root, {
      processStartIdentity: () => 'start-identity',
      readBootToken: () => BOOT_A
    })
    const release = registry.claim(child, {
      runId: 'notebook-run-receipt-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      platform
    })
    return { root, release }
  }

  it('retains an un-reaped receipt and retries cleanup idempotently', async () => {
    const { root } = await claimedReceipt()
    const terminate = vi
      .fn<() => Promise<{ reaped: boolean }>>()
      .mockResolvedValueOnce({ reaped: false })
      .mockResolvedValueOnce({ reaped: true })
    const registry = new ShellProcessOwnershipRegistry(root, {
      processExists: () => true,
      ownedTreeExists: () => true,
      processStartIdentity: () => 'start-identity',
      readBootToken: () => BOOT_A,
      terminateOwnedTree: terminate
    })

    expect(registry.hasReceipts()).toBe(true)
    await expect(registry.recover()).rejects.toMatchObject({
      code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
    })
    await expect(registry.recover()).resolves.toBeUndefined()
    expect(registry.hasReceipts()).toBe(false)
    await expect(registry.recover()).resolves.toBeUndefined()
    expect(terminate).toHaveBeenCalledTimes(2)
  })

  it('fails closed on a crash between launch intent and immutable process identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-process-launch-intent-'))
    roots.push(root)
    const registry = new ShellProcessOwnershipRegistry(root)
    const launch = registry.beginLaunch({
      runId: 'notebook-run-launch-gap-1',
      projectId: 'project-1',
      sessionId: 'session-1'
    })

    await expect(new ShellProcessOwnershipRegistry(root).recover()).rejects.toMatchObject({
      code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
    })
    launch.abort()
    await expect(new ShellProcessOwnershipRegistry(root).recover()).resolves.toBeUndefined()
  })

  it.each([BOOT_A, BOOT_B, undefined, 'invalid-token'])(
    'clears an interrupted launch only when a different valid boot proves it cannot survive: %s',
    async (currentBoot) => {
      const root = await mkdtemp(join(tmpdir(), 'shell-launch-reboot-'))
      roots.push(root)
      const registry = new ShellProcessOwnershipRegistry(root, { readBootToken: () => BOOT_A })
      const launch = registry.beginLaunch({
        runId: 'interrupted-launch',
        projectId: 'project-1',
        sessionId: 'session-1',
        platform: 'linux'
      })
      const probe = vi.fn(() => true)
      const terminate = vi.fn(async () => ({ reaped: true }))
      const recovery = new ShellProcessOwnershipRegistry(root, {
        readBootToken: () => currentBoot,
        processExists: probe,
        ownedTreeExists: probe,
        terminateOwnedTree: terminate
      })
      if (currentBoot === BOOT_B) {
        await recovery.recover()
        await recovery.recover()
        expect(recovery.hasReceipts()).toBe(false)
      } else {
        await expect(recovery.recover()).rejects.toMatchObject({
          code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
        })
        expect(recovery.hasReceipts()).toBe(true)
      }
      expect(probe).not.toHaveBeenCalled()
      expect(terminate).not.toHaveBeenCalled()
      launch.abort()
    }
  )

  it('retains the intact launch intent when atomic receipt promotion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-promotion-failure-'))
    roots.push(root)
    const registry = new ShellProcessOwnershipRegistry(root, {
      readBootToken: () => BOOT_A,
      processStartIdentity: () => 'start-identity'
    })
    const path = join(root, 'shell-process-ownership', 'promotion-failure.json')
    const launch = registry.beginLaunch({
      runId: 'promotion-failure',
      projectId: 'project-1',
      sessionId: 'session-1',
      platform: 'linux'
    })
    const before = await readFile(path, 'utf8')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('atomic rename failed')
    })
    try {
      expect(() => launch.claim({ pid: 4242 } as ChildProcess, 'linux')).toThrow(
        'atomic rename failed'
      )
      expect(await readFile(path, 'utf8')).toBe(before)
      expect(JSON.parse(before)).toMatchObject({ state: 'launching', bootToken: BOOT_A })
    } finally {
      rename.mockRestore()
      launch.abort()
    }
  })

  it('preserves an unrelated process after positively proving PID reuse', async () => {
    const { root } = await claimedReceipt('win32')
    const terminate = vi.fn(async () => ({ reaped: true }))
    const registry = new ShellProcessOwnershipRegistry(root, {
      processExists: () => true,
      ownedTreeExists: () => true,
      processStartIdentity: () => 'different-start-identity',
      terminateOwnedTree: terminate
    })

    await registry.recover()
    await registry.recover()
    expect(terminate).not.toHaveBeenCalled()
  })

  it('never signals a reused POSIX group after a proven reboot', async () => {
    const { root } = await claimedReceipt()
    const terminate = vi.fn(async () => ({ reaped: true }))
    const registry = new ShellProcessOwnershipRegistry(root, {
      processExists: () => true,
      ownedTreeExists: () => true,
      processStartIdentity: () => 'start-identity',
      readBootToken: () => BOOT_B,
      terminateOwnedTree: terminate
    })

    await registry.recover()

    expect(terminate).not.toHaveBeenCalled()
    expect(registry.hasReceipts()).toBe(false)
  })

  it('clears a dead macOS group without requiring a Linux boot token', async () => {
    const { root } = await claimedReceipt('darwin')
    const terminate = vi.fn(async () => ({ reaped: true }))
    const registry = new ShellProcessOwnershipRegistry(root, {
      processExists: () => false,
      ownedTreeExists: () => false,
      terminateOwnedTree: terminate
    })

    await registry.recover()

    expect(terminate).not.toHaveBeenCalled()
    expect(registry.hasReceipts()).toBe(false)
  })

  it('retains a leaderless POSIX group instead of signaling a reused numeric id', async () => {
    const { root } = await claimedReceipt()
    const terminate = vi.fn(async () => ({ reaped: true }))
    const registry = new ShellProcessOwnershipRegistry(root, {
      processExists: () => false,
      ownedTreeExists: () => true,
      readBootToken: () => BOOT_A,
      terminateOwnedTree: terminate
    })

    await expect(registry.recover()).rejects.toMatchObject({
      code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
    })
    expect(terminate).not.toHaveBeenCalled()
    expect(registry.hasReceipts()).toBe(true)
  })

  it('fails closed and retains ownership when start identity cannot be read', async () => {
    const { root } = await claimedReceipt()
    const terminate = vi.fn(async () => ({ reaped: true }))
    const registry = new ShellProcessOwnershipRegistry(root, {
      processExists: () => true,
      ownedTreeExists: () => true,
      processStartIdentity: () => undefined,
      readBootToken: () => BOOT_A,
      terminateOwnedTree: terminate
    })

    await expect(registry.recover()).rejects.toMatchObject({
      code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
    })
    await expect(registry.recover()).rejects.toMatchObject({
      code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
    })
    expect(terminate).not.toHaveBeenCalled()
  })
})
