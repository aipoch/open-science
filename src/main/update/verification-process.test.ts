import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as processTree from '../process-tree'
import {
  runVerificationProcess,
  VerificationProcessExitError,
  VerificationProcessUnsettledError,
  verificationDirectoryIsSettled
} from './verification-process'

describe('bounded verification subprocess', () => {
  it('returns both output streams after successful verification with an input pipe', async () => {
    await expect(
      runVerificationProcess(
        process.execPath,
        ['-e', "process.stdout.write('verified'); process.stderr.write('diagnostic')"],
        { stdin: 'pipe' }
      )
    ).resolves.toEqual({ stdout: 'verified', stderr: 'diagnostic' })
  })

  it('blocks cleanup of an unconfirmed working directory and its parents, but not siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-unsettled-'))
    const directory = join(root, 'candidate')
    const terminate = processTree.terminateProcessTree
    const cleanup = vi
      .spyOn(processTree, 'terminateProcessTree')
      .mockImplementation(async (...args) => {
        // Reap the real fixture before simulating an unconfirmed cleanup receipt.
        await terminate(...args)
        return { reaped: false }
      })
    try {
      await mkdir(directory)
      expect(verificationDirectoryIsSettled(directory)).toBe(true)
      const pending = runVerificationProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: directory
      })
      await expect(pending).rejects.toBeInstanceOf(VerificationProcessUnsettledError)
      await expect(pending).rejects.toMatchObject({ directory })
      expect(verificationDirectoryIsSettled(directory)).toBe(false)
      expect(verificationDirectoryIsSettled(root)).toBe(false)
      expect(verificationDirectoryIsSettled(`${directory}-sibling`)).toBe(true)
    } finally {
      cleanup.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { exitCode: 2, signal: null, terminate: 'process.exit(2)' },
    ...(process.platform === 'win32'
      ? []
      : [{ exitCode: null, signal: 'SIGKILL', terminate: "process.kill(process.pid, 'SIGKILL')" }])
  ])(
    'retains stderr and exit evidence ($exitCode, $signal) without exposing it in the display message',
    async ({ exitCode, signal, terminate }) => {
      const stderr = 'Cannot inspect 安装目录: EACCES\n' + 'detail\n'.repeat(3000)
      const error = await runVerificationProcess(process.execPath, [
        '-e',
        `process.stderr.write(${JSON.stringify(stderr)}, () => { ${terminate} })`
      ]).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(VerificationProcessExitError)
      expect(error).toMatchObject({ exitCode, signal, stderr })
      expect((error as Error).message).not.toContain('EACCES')
    }
  )

  it('cancels a running process and waits for its exit', async () => {
    const controller = new AbortController()
    const pending = runVerificationProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { signal: controller.signal }
    )
    setTimeout(() => controller.abort(new Error('explicit cancellation')), 30)
    await expect(pending).rejects.toThrow('explicit cancellation')
  })
  it('terminates descendants holding inherited pipes within its deadline', async () => {
    const started = Date.now()
    await expect(
      runVerificationProcess(
        process.execPath,
        [
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"
        ],
        { timeoutMs: 100 }
      )
    ).rejects.toThrow('time limit')
    expect(Date.now() - started).toBeLessThan(3000)
  })
  it('ends hung commands without relying on installation age', async () => {
    await expect(
      runVerificationProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeoutMs: 30
      })
    ).rejects.toThrow('time limit')
  })
  it('refuses oversized output while keeping UI timers responsive', async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 5)
    await expect(
      runVerificationProcess(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"],
        { maxBytes: 100 }
      )
    ).rejects.toThrow('output exceeded')
    expect(ticked).toBe(true)
  })
})
