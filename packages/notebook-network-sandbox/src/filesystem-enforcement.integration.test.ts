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
  it.runIf(process.platform === 'linux')(
    'starts with an existing protected .bashrc in a hidden private root',
    async () => {
      const privateRoot = await mkdtemp(join(tmpdir(), 'open-science-protected-home-'))
      const workspace = join(privateRoot, 'workspace')
      const bashrc = join(privateRoot, '.bashrc')
      const ssh = join(privateRoot, '.ssh')
      await mkdir(workspace)
      await mkdir(ssh)
      await writeFile(bashrc, 'private shell configuration\n')
      await writeFile(join(ssh, 'key'), 'private credential')
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: resolve(import.meta.dirname, '../vendor') }
      })

      try {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command:
            'test ! -e "$PROTECTED_PATH" && test ! -e "$SSH_PATH" && printf started > result.txt',
          cwd: workspace,
          env: { PATH: '/usr/bin:/bin', PROTECTED_PATH: bashrc, SSH_PATH: ssh },
          filesystem: {
            privateRoot,
            readOnlyRoots: ['/bin', '/usr/bin'],
            readWriteRoots: [workspace],
            deniedReadRoots: [],
            deniedWriteRoots: [bashrc, ssh]
          },
          onNetworkAccessRequest: async () => false
        })
        const result = await run(wrapped, workspace)
        const diagnostic = wrapped.annotateStderr(result.stderr)
        await wrapped.cleanup('exit', { processesTerminated: true })

        expect(result.code, diagnostic).toBe(0)
        expect(result.stderr).not.toContain('Ignoring extra certs')
        await expect(readFile(join(workspace, 'result.txt'), 'utf8')).resolves.toBe('started')
        await expect(readFile(bashrc, 'utf8')).resolves.toBe('private shell configuration\n')
      } finally {
        await sandbox.dispose()
        await rm(privateRoot, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform === 'linux').each(['absent', 'file', 'directory'])(
    'starts with a hidden %s provider configuration denied both read and write',
    async (kind) => {
      const privateRoot = await mkdtemp(join(tmpdir(), 'open-science-provider-home-'))
      const workspace = join(privateRoot, 'workspace')
      const config = join(privateRoot, '.open-science', 'claude')
      await mkdir(workspace)
      const runtimeRoot = join(privateRoot, '.open-science', 'runtime')
      await mkdir(runtimeRoot, { recursive: true })
      if (kind === 'file') await writeFile(config, 'private provider configuration')
      if (kind === 'directory') {
        await mkdir(config)
        await writeFile(join(config, 'credentials'), 'private provider configuration')
      }
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: resolve(import.meta.dirname, '../vendor') }
      })

      try {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command: 'test ! -e "$PROTECTED_PATH" && printf started > result.txt',
          cwd: workspace,
          env: { PATH: '/usr/bin:/bin', PROTECTED_PATH: config },
          filesystem: {
            privateRoot,
            readOnlyRoots: ['/bin', '/usr/bin', runtimeRoot],
            readWriteRoots: [workspace],
            deniedReadRoots: [config],
            deniedWriteRoots: [config]
          },
          onNetworkAccessRequest: async () => false
        })
        const result = await run(wrapped, workspace)
        const diagnostic = wrapped.annotateStderr(result.stderr)
        await wrapped.cleanup('exit', { processesTerminated: true })

        expect(result.code, diagnostic).toBe(0)
        await expect(readFile(join(workspace, 'result.txt'), 'utf8')).resolves.toBe('started')
        if (kind === 'absent')
          await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' })
        else
          await expect(
            readFile(kind === 'file' ? config : join(config, 'credentials'), 'utf8')
          ).resolves.toBe('private provider configuration')
      } finally {
        await sandbox.dispose()
        await rm(privateRoot, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform === 'linux').each(['file', 'directory', 'ancestor'])(
    'keeps an exposed protected %s unreadable',
    async (kind) => {
      const privateRoot = await mkdtemp(join(tmpdir(), 'open-science-provider-grant-'))
      const workspace = join(privateRoot, 'workspace')
      const config = join(kind === 'ancestor' ? privateRoot : workspace, 'claude')
      const secret = kind === 'file' ? config : join(config, 'credentials')
      await mkdir(workspace)
      if (kind !== 'file') await mkdir(config)
      await writeFile(secret, 'private provider configuration')
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: resolve(import.meta.dirname, '../vendor') }
      })

      try {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command:
            'test "$(cat "$SECRET_PATH" 2>/dev/null)" != "private provider configuration" && ' +
            'printf started > result.txt',
          cwd: workspace,
          env: { PATH: '/usr/bin:/bin', SECRET_PATH: secret },
          filesystem: {
            privateRoot,
            readOnlyRoots: ['/bin', '/usr/bin', ...(kind === 'ancestor' ? [secret] : [])],
            readWriteRoots: [workspace],
            deniedReadRoots: [config],
            deniedWriteRoots: [config]
          },
          onNetworkAccessRequest: async () => false
        })
        const result = await run(wrapped, workspace)
        await wrapped.cleanup('exit', { processesTerminated: true })

        expect(result.code, result.stderr).toBe(0)
        await expect(readFile(join(workspace, 'result.txt'), 'utf8')).resolves.toBe('started')
        await expect(readFile(secret, 'utf8')).resolves.toBe('private provider configuration')
      } finally {
        await sandbox.dispose()
        await rm(privateRoot, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform === 'linux').each(['child', 'ancestor'])(
    'keeps a denied-write %s of a writable grant protected without exposing hidden files',
    async (relationship) => {
      const privateRoot = await mkdtemp(join(tmpdir(), 'open-science-protected-grant-'))
      const workspace = join(privateRoot, 'workspace')
      const protectedDirectory = join(workspace, '.git')
      const config = join(protectedDirectory, 'config')
      const secret = join(privateRoot, 'secret.txt')
      await mkdir(protectedDirectory, { recursive: true })
      await writeFile(config, 'protected')
      await writeFile(secret, 'private')
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: resolve(import.meta.dirname, '../vendor') }
      })

      try {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command:
            'test ! -e "$SECRET_PATH" && test -r "$PROTECTED_PATH" && ' +
            'if printf changed > "$PROTECTED_PATH"; then exit 1; else exit 0; fi',
          cwd: workspace,
          env: { PATH: '/usr/bin:/bin', SECRET_PATH: secret, PROTECTED_PATH: config },
          filesystem: {
            privateRoot,
            readOnlyRoots: ['/bin', '/usr/bin'],
            readWriteRoots: [workspace],
            deniedReadRoots: [],
            deniedWriteRoots: [relationship === 'child' ? protectedDirectory : privateRoot]
          },
          onNetworkAccessRequest: async () => false
        })
        const result = await run(wrapped, workspace)
        await wrapped.cleanup('exit', { processesTerminated: true })
        expect(result.code, result.stderr).toBe(0)
        await expect(readFile(config, 'utf8')).resolves.toBe('protected')
      } finally {
        await sandbox.dispose()
        await rm(privateRoot, { recursive: true, force: true })
      }
    }
  )

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
      await wrapped.cleanup('exit', { processesTerminated: true })

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
      await allowed.cleanup('exit', { processesTerminated: true })
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
      await deniedRead.cleanup('exit', { processesTerminated: true })

      const deniedSymlinkRead = await sandbox.wrap({
        command: `/bin/cat ${secretLink}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const symlinkResult = await run(deniedSymlinkRead, workspace)
      expect(symlinkResult.code).not.toBe(0)
      await deniedSymlinkRead.cleanup('exit', { processesTerminated: true })

      const deniedHostTempRead = await sandbox.wrap({
        command: `/bin/cat ${hostTempSecret}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const hostTempReadResult = await run(deniedHostTempRead, workspace)
      expect(hostTempReadResult.code).not.toBe(0)
      await deniedHostTempRead.cleanup('exit', { processesTerminated: true })

      const deniedReadOnlyWrite = await sandbox.wrap({
        command: `printf blocked > ${join(readOnly, 'input.txt')}`,
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        filesystem,
        onNetworkAccessRequest: async () => false
      })
      const readOnlyWriteResult = await run(deniedReadOnlyWrite, workspace)
      expect(readOnlyWriteResult.code).not.toBe(0)
      await deniedReadOnlyWrite.cleanup('exit', { processesTerminated: true })
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
      await deniedWrite.cleanup('exit', { processesTerminated: true })
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
      await deniedHostTempWrite.cleanup('exit', { processesTerminated: true })
    } finally {
      await sandbox.dispose()
      await rm(privateRoot, { recursive: true, force: true })
      await rm(hostTempRoot, { recursive: true, force: true })
    }
  })
})
