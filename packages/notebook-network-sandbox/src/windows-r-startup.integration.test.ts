import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

import {
  readAppContainerStatus,
  windowsLaunch
} from '../runtime/src/platform/windows-appcontainer.js'
import { createRuntimeConfig } from './config.js'

const rscript = process.env.OPEN_SCIENCE_TEST_RSCRIPT
const dllDirectory = process.env.OPEN_SCIENCE_TEST_R_DLL_DIR

// Opt in against an existing R and an installed protected sandbox. The native launch boundary
// avoids competing with the desktop application's gateway port; neither probe uses the network.
it.skipIf(process.platform !== 'win32' || !rscript).each(['r', 'powershell'] as const)(
  'starts %s against the selected R installation under the real AppContainer',
  async (kind) => {
    const workspace = await mkdtemp(join(tmpdir(), 'windows-r-startup-'))
    const config = createRuntimeConfig({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') }
    })
    const env = {
      ...process.env,
      ...(dllDirectory ? { PATH: `${dllDirectory};${process.env.PATH ?? ''}` } : {})
    }
    const code = 'stopifnot(requireNamespace("jsonlite", quietly=TRUE)); cat("R_READY")'
    try {
      const host = spawnSync(rscript!, ['--vanilla', '-e', code], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000
      })
      expect(host.status, host.stderr).toBe(0)
      expect(host.stdout).toContain('R_READY')
      expect(
        await readAppContainerStatus(
          config.windowsHostPath,
          config.installationId,
          config.windowsOwnershipRoot
        )
      ).toMatchObject({ owned: true, ownershipState: 'owned', profileExists: true })
      const shellCode = `& '${rscript!.replaceAll("'", "''")}' --version`
      const wrapped = windowsLaunch({
        command: '',
        executable:
          kind === 'r'
            ? rscript!
            : join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        args:
          kind === 'r'
            ? ['--vanilla', '-e', code]
            : [
                '-NoProfile',
                '-NonInteractive',
                '-EncodedCommand',
                Buffer.from(shellCode, 'utf16le').toString('base64')
              ],
        cwd: workspace,
        env,
        gatewayPort: 61200,
        gatewayCredentials: { username: 'unused-offline-probe', password: 'unused-offline-probe' },
        hostPath: config.windowsHostPath,
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot,
        filesystem: {
          readOnlyRoots: [dirname(dirname(rscript!)), ...(dllDirectory ? [dllDirectory] : [])],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: workspace,
        env: wrapped.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(kind === 'r' ? 'R_READY' : 'Rscript')
      expect(result.stderr).not.toContain('InitializeDefaultDrives')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  },
  40_000
)
