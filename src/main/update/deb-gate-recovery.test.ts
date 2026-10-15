import { prefetchSystemBootIdentity } from '../system-boot-identity'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  beginInstallationUpdate,
  finishInstallationRecoveryAsync,
  inspectInstallationUpdate,
  installationStateDirectory
} from './installation-protection'
import { cancelDebSystemdGate } from './deb-systemd-gate'
vi.mock('./deb-systemd-gate', () => ({ cancelDebSystemdGate: vi.fn() }))
// Match startup's asynchronous Windows boot query before creating durable update records.
beforeAll(async () => {
  await prefetchSystemBootIdentity()
})

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }))
  vi.resetAllMocks()
})
it('keeps a persisted pre-handoff gate protected until cancellation has actually settled', async () => {
  const base = mkdtempSync(join(tmpdir(), 'deb-recovery-'))
  dirs.push(base)
  const root = join(base, 'app')
  mkdirSync(root)
  writeFileSync(join(root, 'program'), 'old')
  const location = { installationRoot: root, stateRoot: join(base, 'state') }
  const nonce = randomUUID(),
    directory = join(installationStateDirectory(location), 'executor-test')
  mkdirSync(directory, { recursive: true })
  const gate = {
    nonce,
    directory,
    stateDirectory: `/var/lib/open-science-updates/${nonce}`,
    unit: `open-science-install-${nonce}.service`,
    binding: 'a'.repeat(64)
  }
  const record = beginInstallationUpdate({
    ...location,
    currentVersion: '1',
    targetVersion: '2',
    runtime: { pid: process.pid, generation: 'test', configRoot: join(base, 'config') },
    startupOptions: {
      configRoot: join(base, 'config'),
      dataRoot: join(base, 'data'),
      profilePath: join(base, 'profile'),
      host: '127.0.0.1',
      port: 0,
      credentialStore: 'file'
    },
    preparedDebGate: gate,
    inspectProcesses: () => []
  })
  expect(inspectInstallationUpdate(location)?.preparedDebGate).toEqual(gate)
  vi.mocked(cancelDebSystemdGate).mockRejectedValueOnce(new Error('manager unavailable'))
  await expect(
    finishInstallationRecoveryAsync(location, record.operationId, 'cancel')
  ).rejects.toThrow('manager unavailable')
  expect(inspectInstallationUpdate(location)?.operationId).toBe(record.operationId)
  vi.mocked(cancelDebSystemdGate).mockResolvedValueOnce(undefined)
  await finishInstallationRecoveryAsync(location, record.operationId, 'cancel')
  expect(cancelDebSystemdGate).toHaveBeenLastCalledWith(gate)
  expect(inspectInstallationUpdate(location)).toBeUndefined()
})
