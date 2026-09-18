import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { certifyNativeShell } from './native-shell-certification'

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip

describeMacOS('native shell certification through the production sandbox', () => {
  it('reaps a background child, times out and then executes again', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'native-shell-certification-test-')))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'resources'),
      temporaryRoot: join(root, 'command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    try {
      await expect(
        certifyNativeShell({
          appPackaged: true,
          headless: true,
          storageRoot: root,
          environment: {
            OPEN_SCIENCE_E2E_STORAGE_ROOT: root,
            OPEN_SCIENCE_E2E_NATIVE_SHELL_CERTIFICATION: '1'
          },
          processSandbox: owner
        })
      ).resolves.toBeUndefined()
    } finally {
      await owner.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
