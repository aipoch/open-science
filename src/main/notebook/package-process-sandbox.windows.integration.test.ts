import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import { resolveWindowsNotebookRuntime } from './windows-notebook-runtime'

describe.runIf(process.platform === 'win32')('Windows package process sandbox', () => {
  let root = ''
  let workspace = ''
  let runtimeRoot = ''
  let readOnlyFolder = ''
  let writableFolder = ''
  let sandbox: NotebookNetworkSandboxOwner

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'open-science-package-supervisor-')))
    // Native status must inspect this fixture's ownership, not an installed user's protection.
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    workspace = join(root, 'workspace')
    runtimeRoot = join(root, 'runtime')
    readOnlyFolder = join(root, 'read-only-folder')
    writableFolder = join(root, 'writable-folder')
    await Promise.all(
      [workspace, runtimeRoot, readOnlyFolder, writableFolder].map((path) =>
        mkdir(path, { recursive: true })
      )
    )
    sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(root, 'command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      getGrantedLocalRoots: async () => [
        { id: 'ro', name: 'read-only-folder', path: readOnlyFolder, access: 'ro' },
        { id: 'rw', name: 'writable-folder', path: writableFolder, access: 'rw' }
      ],
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny',
      platform: 'win32',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    expect(await sandbox.installWindows()).toEqual({ cancelled: false })
  }, 180_000)

  afterAll(async () => {
    try {
      if (sandbox) {
        expect(await sandbox.removeWindows()).toEqual({ cancelled: false })
        await sandbox.dispose()
      }
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } finally {
      vi.unstubAllEnvs()
    }
  }, 180_000)

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
      spawn(resolveWindowsNotebookRuntime().node, ['-e', 'process.exit(0)'], {})
    ).resolves.toMatchObject({ code: 0 })
    await expect(
      spawn(resolveWindowsNotebookRuntime().node, ['-e', 'process.exit(0)'], {})
    ).resolves.toMatchObject({ code: 0 })
  }, 60_000)

  it('limits native installer writes to runtime and writable Folder grants', async () => {
    const deniedFile = join(root, 'ungranted.txt')
    const readOnlyFile = join(readOnlyFolder, 'data.txt')
    await Promise.all([deniedFile, readOnlyFile].map((path) => writeFile(path, 'original')))
    const spawn = sandboxedPackageSpawn({
      processSandbox: sandbox,
      request: { language: 'python', packages: ['example'], workspaceCwd: workspace },
      runtimeRoot,
      storageRoot: root,
      platform: 'win32'
    })
    const script = `
      const fs = require('node:fs');
      const denied = (operation) => {
        try { operation(); } catch (error) {
          if (['EACCES', 'EPERM'].includes(error.code)) return;
          throw error;
        }
        throw new Error('filesystem access unexpectedly allowed');
      };
      if (fs.readFileSync(${JSON.stringify(readOnlyFile)}, 'utf8') !== 'original') throw new Error('read-only grant unreadable');
      denied(() => fs.writeFileSync(${JSON.stringify(readOnlyFile)}, 'changed'));
      denied(() => fs.readFileSync(${JSON.stringify(deniedFile)}));
      denied(() => fs.writeFileSync(${JSON.stringify(deniedFile)}, 'changed'));
      fs.writeFileSync(${JSON.stringify(join(runtimeRoot, 'installed.txt'))}, 'installed');
      fs.writeFileSync(${JSON.stringify(join(writableFolder, 'data.txt'))}, 'allowed');
    `
    await expect(
      spawn(resolveWindowsNotebookRuntime().node, ['-e', script], {})
    ).resolves.toMatchObject({ code: 0 })
    expect(await readFile(deniedFile, 'utf8')).toBe('original')
    expect(await readFile(readOnlyFile, 'utf8')).toBe('original')
    expect(await readFile(join(runtimeRoot, 'installed.txt'), 'utf8')).toBe('installed')
    expect(await readFile(join(writableFolder, 'data.txt'), 'utf8')).toBe('allowed')
  }, 60_000)
})
