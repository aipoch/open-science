import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { sandboxedPackageSpawn } from './package-process-sandbox'

describe.runIf(process.platform === 'win32')('Windows package process sandbox', () => {
  let root = ''
  let workspace = ''
  let runtimeRoot = ''
  let sandbox: NotebookNetworkSandboxOwner

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-package-supervisor-'))
    workspace = join(root, 'workspace')
    runtimeRoot = join(root, 'runtime')
    await Promise.all([workspace, runtimeRoot].map((path) => mkdir(path, { recursive: true })))
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

  it('runs consecutive native installers without carrying an incomplete cleanup forward', async () => {
    const spawn = sandboxedPackageSpawn({
      processSandbox: sandbox,
      request: {
        language: 'python',
        packages: ['example'],
        sessionId: 'package-supervisor-session',
        projectId: 'package-supervisor-project',
        workspaceCwd: workspace
      },
      runtimeRoot,
      storageRoot: root,
      platform: 'win32'
    })

    await expect(
      spawn(process.execPath, ['-e', 'process.exit(0)'], process.env)
    ).resolves.toMatchObject({ code: 0 })
    await expect(
      spawn(process.execPath, ['-e', 'process.exit(0)'], process.env)
    ).resolves.toMatchObject({ code: 0 })
  })
})
