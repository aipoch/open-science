import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createPosixProcessTreeOwnership,
  terminateProcessTree,
  trackOwnedPosixProcessTree
} from './process-tree'

const native = createRequire(import.meta.url)(
  '@aipoch/process-tree-native'
) as typeof import('@aipoch/process-tree-native')

it.skipIf(process.platform !== 'darwin').each(['running', 'exited'] as const)(
  'does not let a %s external launchd service permanently block an owned tree teardown',
  async (serviceState) => {
    const directory = await mkdtemp(join(tmpdir(), 'foreign-service-cleanup-'))
    const label = `com.aipoch.process-tree-test.${randomUUID()}`
    const pidFile = join(directory, 'pid')
    const ownership = createPosixProcessTreeOwnership(process.env)
    let child: ChildProcess | undefined
    let service: ReturnType<typeof native.getDarwinProcess> = null
    let submitted = false
    let unreadable = true
    let exitedAfterSnapshot = false
    const list = native.listDarwinProcesses.bind(native)
    const snapshotObservation = vi.spyOn(native, 'listDarwinProcesses').mockImplementation(() => {
      const snapshot = list()
      const observedService = service
      if (
        serviceState === 'exited' &&
        !exitedAfterSnapshot &&
        observedService &&
        snapshot?.processes.some(
          (identity) =>
            identity.pid === observedService.pid && identity.uniqueId === observedService.uniqueId
        ) &&
        native.getDarwinProcess(observedService.pid)?.uniqueId === observedService.uniqueId
      ) {
        process.kill(observedService.pid, 'SIGKILL')
        const deadline = Date.now() + 1000
        while (
          native.getDarwinProcess(observedService.pid)?.uniqueId === observedService.uniqueId
        ) {
          if (Date.now() >= deadline)
            throw new Error('Test service did not exit after its snapshot')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        }
        exitedAfterSnapshot = true
      }
      return snapshot
    })
    const read = native.getDarwinEnvironmentValue.bind(native)
    const observation = vi
      .spyOn(native, 'getDarwinEnvironmentValue')
      .mockImplementation((pid, name) => {
        if (pid === service?.pid && unreadable) {
          return null
        }
        return read(pid, name)
      })
    try {
      child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], {
        detached: true,
        env: ownership.env,
        stdio: 'ignore'
      })
      trackOwnedPosixProcessTree(child, ownership.token)
      execFileSync(
        '/bin/launchctl',
        [
          'submit',
          '-l',
          label,
          '--',
          process.execPath,
          '-e',
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},20000)`)}],{detached:true,stdio:'ignore'});child.unref()`
        ],
        { timeout: 5000 }
      )
      submitted = true
      service = await vi.waitFor(async () => {
        const identity = native.getDarwinProcess(Number(await readFile(pidFile, 'utf8')))
        expect(identity).not.toBeNull()
        expect(identity!.ppid).toBe(1)
        return identity!
      })
      expect(service.ppid).toBe(1)
      expect(service.pgid).toBe(service.pid)
      expect(service.sid).toBe(service.pid)
      expect(read(service.pid, 'OPEN_SCIENCE_PROCESS_TREE_ID')).toBe(false)
      const leader = native.getDarwinProcess(child.pid!)!
      const first = await terminateProcessTree(child)
      unreadable = false
      const retry = await terminateProcessTree(child)
      if (serviceState === 'exited') {
        expect(exitedAfterSnapshot).toBe(true)
        expect(native.getDarwinProcess(service.pid)?.uniqueId).not.toBe(service.uniqueId)
      } else {
        expect(native.getDarwinProcess(service.pid)?.uniqueId).toBe(service.uniqueId)
      }
      expect(first).toEqual({ reaped: true })
      expect(retry).toEqual({ reaped: true })
      expect(leader.coalitionId).toMatch(/^[1-9][0-9]*$/)
      expect(service.coalitionId).toMatch(/^[1-9][0-9]*$/)
      expect(service.coalitionId).not.toBe(leader.coalitionId)
    } finally {
      snapshotObservation.mockRestore()
      observation.mockRestore()
      try {
        if (submitted) execFileSync('/bin/launchctl', ['remove', label], { timeout: 5000 })
      } finally {
        if (service && native.getDarwinProcess(service.pid)?.uniqueId === service.uniqueId) {
          try {
            process.kill(service.pid, 'SIGKILL')
          } catch {
            /* Already stopped by launchd. */
          }
        }
        if (child) await terminateProcessTree(child)
        await rm(directory, { recursive: true, force: true })
      }
    }
  },
  20_000
)
