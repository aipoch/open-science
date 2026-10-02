import { resolve, join } from 'node:path'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { windowsLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import { createRuntimeConfig } from '../../../packages/notebook-network-sandbox/src/config'
import catalog from './windows-runtime-catalog.json'
import { probeWindowsRuntimeComponent } from './windows-runtime-probe'
import { extractPackArchive } from './pack-archive'
import type { NotebookProcessSandbox } from './process-sandbox'
import {
  WindowsRuntimeComponentStore,
  verifyWindowsRuntimeComponent,
  type WindowsRuntimeComponentRelease
} from './windows-runtime-components'

const enabled = process.platform === 'win32' && process.env.RUN_WINDOWS_CDN_RUNTIME === '1'

it.skipIf(!enabled).each(['node', 'powershell'] as const)(
  'verifies the signed CDN %s component through the actual native containment boundary',
  async (component) => {
    const root = process.env.OPEN_SCIENCE_TEST_SIGNED_RUNTIME_ROOT
    if (!root) throw new Error('An explicit signed runtime fixture is required.')
    const release = catalog.releases.find(
      (entry) => entry.component === component
    ) as unknown as WindowsRuntimeComponentRelease
    const directory = join(resolve(root), component)
    await verifyWindowsRuntimeComponent(release, directory)
    const config = createRuntimeConfig({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
      packaged: false
    })
    const installationId = process.env.OPEN_SCIENCE_TEST_SANDBOX_INSTALLATION_ID
    const ownershipRoot = process.env.OPEN_SCIENCE_TEST_SANDBOX_OWNERSHIP_ROOT
    if (Boolean(installationId) !== Boolean(ownershipRoot))
      throw new Error('Test sandbox identity requires its ownership root.')
    const wrap: NotebookProcessSandbox['wrap'] = async (request) => {
      const launched = windowsLaunch({
        command: '',
        executable: request.executable,
        args: [...request.args],
        cwd: request.cwd,
        env: request.env,
        gatewayPort: 61200,
        gatewayCredentials: { username: 'offline-probe', password: 'offline-probe' },
        hostPath: config.windowsHostPath,
        installationId: installationId ?? config.installationId,
        ownershipRoot: ownershipRoot ?? config.windowsOwnershipRoot,
        filesystem: request.filesystem
      })
      return {
        executable: launched.argv[0],
        args: launched.argv.slice(1),
        env: launched.env,
        confirmProcessTreeTermination: launched.confirmProcessTreeTermination,
        annotateStderr: (stderr) => stderr,
        cleanup: async (_reason, outcome) => ({
          processesTerminated: outcome.processesTerminated,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
      }
    }
    await expect(
      probeWindowsRuntimeComponent(
        {
          release,
          root: directory,
          executable: join(directory, component === 'node' ? 'node.exe' : 'pwsh.exe')
        },
        wrap
      )
    ).resolves.toBeUndefined()
    const archiveRoot = process.env.OPEN_SCIENCE_TEST_RUNTIME_ARCHIVES
    if (!archiveRoot)
      throw new Error('Explicit signed archives are required for the installation test.')
    const cache = await mkdtemp(join(tmpdir(), 'notebook-cdn-install-'))
    try {
      let downloads = 0
      const store = new WindowsRuntimeComponentStore(cache, {
        download: async (_release, destination) => {
          downloads++
          await copyFile(join(archiveRoot, `${component}.tar.zst`), destination)
        },
        extract: extractPackArchive,
        probe: (selection, signal) => probeWindowsRuntimeComponent(selection, wrap, signal)
      })
      const request = { component, architecture: 'x64', officialRoots: [], allowDownload: true }
      const selected = await store.select([release], request)
      expect(selected.root).toContain(release.archive.sha256)
      expect(await store.select([release], { ...request, allowDownload: false })).toEqual(selected)
      expect(downloads).toBe(1)
    } finally {
      await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60_000
)
