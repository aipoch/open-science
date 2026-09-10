import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { runShellCommand } from './shell-process'

const enabled =
  process.platform === 'win32' && process.env.OPEN_SCIENCE_WSL_SETUP_INTEGRATION === '1'

describe.runIf(enabled)('WSL setup PowerShell execution', () => {
  let root = ''
  let workspace = ''
  let sandbox: NotebookNetworkSandboxOwner

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-wsl-setup-shell-'))
    workspace = join(root, 'workspace')
    await Promise.all(
      [workspace, join(root, 'handoff'), join(root, 'runtime')].map((path) =>
        mkdir(path, { recursive: true })
      )
    )
    sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(root, 'command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny',
      platform: 'win32',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
  })

  afterAll(async () => {
    await sandbox?.dispose()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('reaches the real Windows WSL executable through the app process sandbox', async () => {
    const result = await runShellCommand({
      command: '& "$env:SystemRoot\\System32\\wsl.exe" --status; exit $LASTEXITCODE',
      cwd: workspace,
      handoffDir: join(root, 'handoff'),
      runtimeRoot: join(root, 'runtime'),
      notebookSessionRoot: root,
      executionReference: 'wsl-setup-powershell-sandbox',
      sessionId: 'wsl-setup-session',
      projectId: 'wsl-setup-project',
      platform: 'win32',
      runtimeBinding: { kind: 'powershell', version: '5.1' },
      processSandbox: sandbox,
      timeoutMs: 30_000
    })

    expect(result.exitCode).toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Access is denied')
  }, 35_000)
})
