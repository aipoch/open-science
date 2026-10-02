import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { windowsLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import { ViolationLog } from '../../../packages/notebook-network-sandbox/runtime/src/gateway/violation-log'
import { createRuntimeConfig } from '../../../packages/notebook-network-sandbox/src/config'
import { LocalFsService, type GrantedLocalRootsStore } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))

// Uses existing protection; grants only disposable fixture directories. No setup or UAC.
it.skipIf(process.platform !== 'win32' || process.env.OPEN_SCIENCE_TEST_PATH_ACL !== '1')(
  'recovers real AppContainer file denial with explicit grants shared across sessions and revocation',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'notebook-folder-grant-')))
    const folder = join(root, 'config')
    const file = join(folder, 'settings.json')
    const sessionA = join(root, 'session-a')
    const sessionB = join(root, 'session-b')
    const config = createRuntimeConfig({
      resources: {
        root: resolve(
          process.env.OPEN_SCIENCE_TEST_SANDBOX_RESOURCE_ROOT ??
            'packages/notebook-network-sandbox/vendor'
        )
      },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    let roots: GrantedLocalRoot[] = []
    const store: GrantedLocalRootsStore = {
      list: async () => roots,
      upsertByPath: async (entry) => {
        roots = [entry]
        return entry
      },
      setAccess: async (id, access) => {
        roots = roots.map((entry) => (entry.id === id ? { ...entry, access } : entry))
      },
      remove: async (id) => {
        roots = roots.filter((entry) => entry.id !== id)
      }
    }
    const policyChange = vi.fn(async () => ({ reaped: true }))
    const service = new LocalFsService(store, policyChange)
    const executable = resolve(
      process.env.OPEN_SCIENCE_TEST_WINDOWS_NODE ??
        'packages/notebook-network-sandbox/vendor/windows-runtime/x64/node/node.exe'
    )
    const execute = async (
      cwd: string,
      mode: 'read' | 'write' = 'read',
      output = 'stderr'
    ): Promise<SpawnSyncReturns<string>> => {
      const grants = await service.listGrantedRoots()
      const script = `
        const fs = require('node:fs');
        try {
          ${mode === 'read' ? `process.stdout.write(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));` : `fs.writeFileSync(${JSON.stringify(file)}, 'changed');`}
        } catch (error) {
          const message = ${output === 'json' ? 'JSON.stringify({ error: error.message })' : 'error.message'};
          process.${output === 'stderr' ? 'stderr' : 'stdout'}.write(message);
          process.exitCode = 1;
        }
      `
      const wrapped = windowsLaunch({
        command: '',
        executable,
        args: ['-e', script],
        cwd,
        env: { SystemRoot: process.env.SystemRoot, TEMP: cwd, TMP: cwd },
        hostPath: config.windowsHostPath,
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot,
        gatewayPort: 61200,
        gatewayCredentials: { username: 'unused-fixture', password: 'unused-fixture' },
        filesystem: {
          readOnlyRoots: [dirname(executable), ...grants.map((entry) => entry.path)],
          readWriteRoots: [
            cwd,
            ...grants.filter((entry) => entry.access === 'rw').map((entry) => entry.path)
          ],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      try {
        const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
          cwd,
          env: wrapped.env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000
        })
        expect(result.error, result.stderr).toBeUndefined()
        return result
      } finally {
        expect(await wrapped.confirmProcessTreeTermination()).toBe(true)
      }
    }
    try {
      await Promise.all([folder, sessionA, sessionB].map((path) => mkdir(path)))
      await writeFile(file, '{"fixture":true}')
      for (const output of ['stderr', 'stdout', 'json'] as const) {
        // The fixture formats an actual failed read, including JSON-escaped Windows paths.
        const denied = await execute(sessionA, 'read', output)
        expect(denied.status).toBe(1)
        expect(denied.stdout + denied.stderr).toMatch(/EPERM|EACCES/)
        const stdout = denied.stdout
        const diagnostic = new ViolationLog().attach(output, denied.stderr, undefined, stdout)
        expect(diagnostic, JSON.stringify({ output, stdout, stderr: denied.stderr })).toContain(
          `OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${file}`
        )
        expect(denied.stdout).toBe(stdout)
        expect(await service.listGrantedRoots()).toEqual([])
        expect(policyChange).not.toHaveBeenCalled()
      }
      const [grant] = await service.grantRoot({ path: folder, access: 'ro' })
      expect(policyChange).toHaveBeenCalledTimes(1)
      for (const session of [sessionA, sessionB]) {
        const retried = await execute(session)
        expect(retried.status, retried.stderr).toBe(0)
        expect(retried.stdout).toBe('{"fixture":true}')
      }
      expect((await execute(sessionB, 'write')).status).not.toBe(0)
      expect(await readFile(file, 'utf8')).toBe('{"fixture":true}')
      await service.setGrantedRootAccess({ id: grant.id, access: 'rw' })
      const written = await execute(sessionB, 'write')
      expect(written.status, written.stderr).toBe(0)
      expect(await readFile(file, 'utf8')).toContain('changed')
      await service.removeGrantedRoot({ id: grant.id })
      for (const session of [sessionA, sessionB]) {
        expect((await execute(session)).status).not.toBe(0)
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000
)
