import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  getWindowsRuntimeAccess,
  readAppContainerStatus,
  windowsLaunch
} from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import { createRuntimeConfig } from '../../../packages/notebook-network-sandbox/src/config'
import { windowsCondaPrefixForR } from './environment-discovery'
import { kernelExecutableReadRoot } from './kernel-executable-read-root'
import {
  buildNotebookKernelEnvironment,
  environmentPathRoots,
  normalizeRProcessLocale
} from './process-environment'
import { condaActivatedPath } from './runtime-paths'

const rscript = process.env.OPEN_SCIENCE_TEST_RSCRIPT
const run = promisify(execFile)

// Existing installation only. This checks native launch, not the UAC authorization transaction.
it.skipIf(process.platform !== 'win32' || !rscript)(
  'normalizes R library paths and evaluates arithmetic using the production launch roots',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-r-report-current-'))
    const config = createRuntimeConfig({
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    const prefix = windowsCondaPrefixForR(rscript!, process.platform)
    const env = {
      ...normalizeRProcessLocale(buildNotebookKernelEnvironment(), process.platform),
      ...(prefix ? { PATH: condaActivatedPath(prefix, process.env.PATH) } : {}),
      TEMP: root,
      TMP: root
    }
    const args = [
      '--vanilla',
      '-e',
      'normalizePath(c(.Library, file.path(.Library, "compiler")), mustWork=TRUE); stopifnot(requireNamespace("jsonlite", quietly=TRUE)); stopifnot(1 + 1 == 2); cat("R_REPORT_OK")'
    ]
    try {
      // The same executable must work when its conda DLL directory is supplied explicitly. This
      // separates a broken installation from the production environment construction under test.
      const controlPrefix = resolve(dirname(rscript!), '../../../..')
      const control = await run(rscript!, args, {
        env: { ...env, PATH: condaActivatedPath(controlPrefix, process.env.PATH) },
        cwd: root,
        windowsHide: true,
        timeout: 15_000
      })
      expect(control.stdout).toContain('R_REPORT_OK')
      const host = await run(rscript!, args, {
        env,
        cwd: root,
        windowsHide: true,
        timeout: 15_000
      }).then(
        (value) => ({ code: 0, ...value }),
        (error: { code: unknown; stdout: string; stderr: string }) => ({
          code: error.code,
          stdout: error.stdout,
          stderr: error.stderr
        })
      )
      expect(host, JSON.stringify(host)).toMatchObject({ code: 0 })
      expect(host.stdout).toContain('R_REPORT_OK')
      const status = await readAppContainerStatus(
        config.windowsHostPath!,
        config.installationId,
        config.windowsOwnershipRoot!
      )
      expect(status).toMatchObject({ owned: true, profileExists: true, networkFenceReady: true })
      const before = await getWindowsRuntimeAccess(
        config.windowsHostPath!,
        config.installationId,
        config.windowsOwnershipRoot!,
        rscript!
      )
      const wrapped = windowsLaunch({
        command: '',
        executable: rscript!,
        args,
        cwd: root,
        env,
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot!,
        hostPath: config.windowsHostPath!,
        gatewayPort: status.gatewayPort!,
        gatewayCredentials: { username: 'unused-offline-probe', password: 'unused-offline-probe' },
        filesystem: {
          readOnlyRoots: [kernelExecutableReadRoot(rscript!, 'r', process.platform)],
          optionalReadOnlyRoots: environmentPathRoots(env, process.platform),
          readWriteRoots: [root],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const result = await run(wrapped.argv[0]!, wrapped.argv.slice(1), {
        env: wrapped.env,
        cwd: root,
        windowsHide: true,
        timeout: 60_000
      }).then(
        (value) => ({ code: 0, ...value }),
        (error: { code: unknown; stdout: string; stderr: string }) => ({
          code: error.code,
          stdout: error.stdout,
          stderr: error.stderr
        })
      )
      expect(await wrapped.confirmProcessTreeTermination()).toBe(true)
      expect(
        await getWindowsRuntimeAccess(
          config.windowsHostPath!,
          config.installationId,
          config.windowsOwnershipRoot!,
          rscript!
        )
      ).toEqual(before)
      expect(result, JSON.stringify(result)).toMatchObject({
        code: 0,
        stdout: expect.stringContaining('R_REPORT_OK')
      })
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  90_000
)
