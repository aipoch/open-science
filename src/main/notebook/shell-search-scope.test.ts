import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellRuntimeBinding } from '../../shared/notebook'
import { runShellCommand } from './shell-process'
import type { NotebookProcessSandbox } from './process-sandbox'

describe('Shell search filesystem policy delegation', () => {
  let root: string
  let cwd: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-search-policy-'))
    cwd = join(root, 'workspace')
    await mkdir(cwd)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each<{
    platform: NodeJS.Platform
    runtimeBinding: ShellRuntimeBinding
    command: string
  }>([
    {
      platform: 'linux',
      runtimeBinding: { kind: 'native-posix', shell: '/bin/sh' },
      command: 'command -v diagnostic-tool; ls ~/.diagnostic-tools; ls ../outside'
    },
    {
      platform: 'win32',
      runtimeBinding: { kind: 'powershell', version: '5.1' },
      command: 'Get-Command diagnostic-tool; Get-ChildItem $env:USERPROFILE'
    },
    {
      platform: 'win32',
      runtimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'fixture',
        distro: 'fixture',
        user: 'fixture'
      },
      command: 'command -v diagnostic-tool; ls ~/.diagnostic-tools; ls /mnt/c/tools'
    }
  ])('preserves sandbox admission and roots for $runtimeBinding.kind', async (entry) => {
    const inputRoot = join(root, 'inputs')
    const protectedDir = join(cwd, 'protected')
    await mkdir(inputRoot)
    await mkdir(protectedDir)
    const wrap = vi
      .fn<NotebookProcessSandbox['wrap']>()
      .mockRejectedValue(new Error('fixture filesystem policy denied access'))
    const result = await runShellCommand({
      ...entry,
      cwd,
      handoffDir: cwd,
      runtimeRoot: root,
      inputRoot,
      protectedDirs: [protectedDir],
      environment: {},
      sessionId: 'fixture-session',
      projectId: 'fixture-project',
      previewAvailable: () => true,
      processSandbox: { wrap }
    })
    expect(result).toMatchObject({
      exitCode: null,
      stderr:
        entry.runtimeBinding.kind === 'wsl2-bash'
          ? 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.'
          : 'fixture filesystem policy denied access'
    })
    expect(wrap).toHaveBeenCalledOnce()
    expect(wrap.mock.calls[0][0]).toMatchObject({
      commandText: entry.command,
      sessionId: 'fixture-session',
      projectId: 'fixture-project',
      filesystem: {
        readOnlyRoots: expect.arrayContaining([root, inputRoot]),
        readWriteRoots: expect.arrayContaining([cwd]),
        deniedReadRoots: [protectedDir],
        deniedWriteRoots: [inputRoot, protectedDir]
      }
    })
    expect(wrap.mock.calls[0][0].filesystem.readOnlyRoots).not.toContain(join(root, 'outside'))
    expect(wrap.mock.calls[0][0].filesystem.readWriteRoots).not.toContain(join(root, 'outside'))
  })
})

configureTestRuntimeMetadata()
