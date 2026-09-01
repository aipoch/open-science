import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NotebookNetworkSandbox } from './index.js'
import type { NotebookFilesystemPolicy, NotebookSandboxedProcess } from './types.js'

const run = (
  wrapped: NotebookSandboxedProcess,
  cwd: string
): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      cwd,
      env: wrapped.env,
      shell: false
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code, stderr }))
  })

const platformSupported = process.platform === 'darwin' || process.platform === 'linux'

describe.runIf(platformSupported)('Notebook filesystem enforcement', () => {
  it('keeps the standard null device writable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'open-science-null-device-'))
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })

    try {
      await sandbox.initialize()
      const wrapped = await sandbox.wrap({
        command: 'printf discarded > /dev/null',
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem: {
          readOnlyRoots: ['/bin', '/usr/bin'],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        onNetworkAccessRequest: async () => false
      })
      const result = await run(wrapped, workspace)
      const diagnostic = wrapped.annotateStderr(result.stderr)
      wrapped.cleanup()

      expect(result.code, diagnostic).toBe(0)
    } finally {
      await sandbox.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('keeps the private root hidden while allowing declared workspace writes', async () => {
    const privateRoot = await mkdtemp(join(tmpdir(), 'open-science-private-'))
    const hostTempRoot = await mkdtemp(join(tmpdir(), 'open-science-host-temp-'))
    const workspace = join(privateRoot, 'workspace')
    const secret = join(privateRoot, 'secret.txt')
    const secretLink = join(workspace, 'linked-secret.txt')
    const readOnly = join(privateRoot, 'read-only')
    const outsideWrite = join(privateRoot, 'outside.txt')
    const hostTempSecret = join(hostTempRoot, 'secret.txt')
    await mkdir(workspace)
    await mkdir(readOnly)
    await writeFile(secret, 'private', 'utf8')
    await writeFile(hostTempSecret, 'host temporary data', 'utf8')
    await writeFile(join(readOnly, 'input.txt'), 'input', 'utf8')
    await symlink(secret, secretLink)
    const filesystem: NotebookFilesystemPolicy = {
      privateRoot,
      readOnlyRoots: ['/bin', '/usr/bin', readOnly],
      readWriteRoots: [workspace],
      deniedReadRoots: [],
      deniedWriteRoots: []
    }
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })

    try {
      await sandbox.initialize()
      const allowed = await sandbox.wrap({
        command: `printf allowed > ${join(workspace, 'result.txt')}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const allowedResult = await run(allowed, workspace)
      expect(allowedResult.code, allowedResult.stderr).toBe(0)
      allowed.cleanup()
      await expect(readFile(join(workspace, 'result.txt'), 'utf8')).resolves.toBe('allowed')

      const deniedRead = await sandbox.wrap({
        command: `/bin/cat ${secret}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const readResult = await run(deniedRead, workspace)
      expect(readResult.code).not.toBe(0)
      expect(deniedRead.annotateStderr(readResult.stderr)).toContain(
        'OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED'
      )
      deniedRead.cleanup()

      const deniedSymlinkRead = await sandbox.wrap({
        command: `/bin/cat ${secretLink}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const symlinkResult = await run(deniedSymlinkRead, workspace)
      expect(symlinkResult.code).not.toBe(0)
      deniedSymlinkRead.cleanup()

      const deniedHostTempRead = await sandbox.wrap({
        command: `/bin/cat ${hostTempSecret}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const hostTempReadResult = await run(deniedHostTempRead, workspace)
      expect(hostTempReadResult.code).not.toBe(0)
      deniedHostTempRead.cleanup()

      const deniedReadOnlyWrite = await sandbox.wrap({
        command: `printf blocked > ${join(readOnly, 'input.txt')}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const readOnlyWriteResult = await run(deniedReadOnlyWrite, workspace)
      expect(readOnlyWriteResult.code).not.toBe(0)
      deniedReadOnlyWrite.cleanup()
      await expect(readFile(join(readOnly, 'input.txt'), 'utf8')).resolves.toBe('input')

      const deniedWrite = await sandbox.wrap({
        command: `printf blocked > ${outsideWrite}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const writeResult = await run(deniedWrite, workspace)
      expect(writeResult.code).not.toBe(0)
      expect(deniedWrite.annotateStderr(writeResult.stderr)).toContain(
        'OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED'
      )
      deniedWrite.cleanup()
      await expect(readFile(outsideWrite, 'utf8')).rejects.toThrow()

      const deniedHostTempWrite = await sandbox.wrap({
        command: `printf blocked > ${join(hostTempRoot, 'outside.txt')}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const hostTempWriteResult = await run(deniedHostTempWrite, workspace)
      expect(hostTempWriteResult.code).not.toBe(0)
      deniedHostTempWrite.cleanup()
    } finally {
      await sandbox.dispose()
      await rm(privateRoot, { recursive: true, force: true })
      await rm(hostTempRoot, { recursive: true, force: true })
    }
  })
})
