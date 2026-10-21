import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { acquireRuntimeDirectorySync } from '../runtime-ownership'
import {
  beginInstallationUpdate,
  advanceInstallationUpdate,
  bindInstallationExecutor,
  captureInstallationManifest,
  inspectInstallationUpdate,
  inspectInstallationStartup,
  installationStateDirectory
} from './installation-protection'
import {
  recoverInstallationAfterSystemRestart,
  installationManifestIdentity
} from './installation-reboot-recovery'
// Boot-query failures are covered separately; recovery fixtures need a stable initial boot.
vi.mock('../system-boot-identity', async (original) => ({
  ...(await original<typeof import('../system-boot-identity')>()),
  systemBootIdentity: () => 'windows-boot:12345678-1234-4321-8123-123456789abc'
}))

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })))
type Fixture = {
  base: string
  app: string
  location: { installationRoot: string; stateRoot: string }
  record: ReturnType<typeof beginInstallationUpdate>
  options: {
    version: string
    inspectProcesses: () => Promise<number[]>
    readBootIdentity: () => string
  }
}
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'reboot-recovery-'))
  dirs.push(base)
  const app = join(base, 'app'),
    target = join(base, 'target'),
    configRoot = join(base, 'config'),
    dataRoot = join(base, 'data'),
    profilePath = join(base, 'profile')
  for (const p of [app, target, configRoot, dataRoot, profilePath]) mkdirSync(p)
  writeFileSync(join(app, 'program'), 'old')
  writeFileSync(join(target, 'program'), 'new')
  const location = { installationRoot: app, stateRoot: join(base, 'state') }
  const record = beginInstallationUpdate({
    ...location,
    currentVersion: '1',
    targetVersion: '2',
    runtime: { pid: process.pid, generation: 'original', configRoot },
    startupOptions: {
      configRoot,
      dataRoot,
      profilePath,
      host: '127.0.0.1',
      port: 0,
      credentialStore: 'file'
    },
    targetManifest: captureInstallationManifest(target, '2'),
    inspectProcesses: () => []
  })
  const newBoot = record.bootIdentity!.split(':')[0] + ':ffffffff-ffff-4fff-8fff-ffffffffffff'
  const options = {
    version: '1',
    inspectProcesses: async () => [] as number[],
    readBootIdentity: () => newBoot
  }
  return { base, app, location, record, options }
}
function handoff(f: ReturnType<typeof fixture>): string {
  advanceInstallationUpdate(f.location, f.record.operationId, 'stopping')
  advanceInstallationUpdate(f.location, f.record.operationId, 'stopped', true)
  advanceInstallationUpdate(f.location, f.record.operationId, 'handoff')
  const directory = join(installationStateDirectory(f.location), 'executor-test')
  mkdirSync(directory)
  const bytes = JSON.stringify({
    operationId: f.record.operationId,
    bootIdentity: f.record.bootIdentity,
    channel: 'supervised-deb',
    installationRoot: f.record.installationRoot,
    recordPath: join(installationStateDirectory(f.location), 'update-in-progress.json'),
    oldManifestSha256: installationManifestIdentity(f.record.oldManifest),
    targetManifestSha256: installationManifestIdentity(f.record.targetManifest)
  })
  writeFileSync(join(directory, 'request.json'), bytes)
  bindInstallationExecutor(f.location, f.record.operationId, {
    channel: 'supervised-deb',
    directory,
    requestSha256: createHash('sha256').update(bytes).digest('hex')
  })
  writeFileSync(join(directory, 'installer-count'), '1')
  return directory
}
it.each(['missing', 'failed'])(
  'recovers an unfinished stop with %s exit evidence only after a trusted reboot',
  async (evidence) => {
    const f = fixture()
    advanceInstallationUpdate(f.location, f.record.operationId, 'stopping', false)
    if (evidence === 'failed')
      writeFileSync(
        join(f.record.startupOptions.configRoot, 'runtime-exit.json'),
        'failed fixture evidence'
      )
    expect(
      await recoverInstallationAfterSystemRestart(f.location, f.record.operationId, {
        ...f.options,
        readBootIdentity: () => f.record.bootIdentity!
      })
    ).toBeUndefined()
    expect(inspectInstallationUpdate(f.location)?.stoppedClean).toBe(false)
    const result = await recoverInstallationAfterSystemRestart(
      f.location,
      f.record.operationId,
      f.options
    )
    expect(result?.intent).toBe('cancel')
    expect(inspectInstallationUpdate(f.location)).toBeUndefined()
    expect(inspectInstallationStartup(f.location)?.manifest.version).toBe('1')
    if (evidence === 'failed')
      expect(
        readFileSync(join(f.record.startupOptions.configRoot, 'runtime-exit.json'), 'utf8')
      ).toBe('failed fixture evidence')
  }
)
it.each(['old', 'target'])(
  'settles unknown native %s files after reboot without reapplying installer',
  async (installed) => {
    const f = fixture(),
      directory = handoff(f)
    if (installed === 'target') writeFileSync(join(f.app, 'program'), 'new')
    expect(
      await recoverInstallationAfterSystemRestart(f.location, f.record.operationId, {
        ...f.options,
        readBootIdentity: () => f.record.bootIdentity!
      })
    ).toBeUndefined()
    expect(existsSync(join(directory, 'result.json'))).toBe(false)
    const result = await recoverInstallationAfterSystemRestart(f.location, f.record.operationId, {
      ...f.options,
      version: installed === 'target' ? '2' : '1'
    })
    expect(result?.intent).toBe(installed === 'target' ? 'complete' : 'cancel')
    expect(readFileSync(join(directory, 'installer-count'), 'utf8')).toBe('1')
    expect(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'))).toMatchObject({
      settlement: 'system-restart',
      outcome: installed === 'target' ? 'installed' : 'rolled-back'
    })
  }
)
it('keeps partial installations and changed request identities protected', async () => {
  const f = fixture(),
    directory = handoff(f)
  writeFileSync(join(f.app, 'program'), 'partial')
  await expect(
    recoverInstallationAfterSystemRestart(f.location, f.record.operationId, f.options)
  ).rejects.toThrow('Restore the original')
  expect(inspectInstallationUpdate(f.location)).toBeDefined()
  writeFileSync(join(directory, 'request.json'), 'changed')
  await expect(
    recoverInstallationAfterSystemRestart(f.location, f.record.operationId, f.options)
  ).rejects.toThrow('request changed')
})
it.each(['configRoot', 'dataRoot', 'profilePath'] as const)(
  'requires the original %s lock even after reboot',
  async (key) => {
    const f = fixture()
    advanceInstallationUpdate(f.location, f.record.operationId, 'stopping')
    const lease = acquireRuntimeDirectorySync(f.record.startupOptions[key])
    try {
      await expect(
        recoverInstallationAfterSystemRestart(f.location, f.record.operationId, f.options)
      ).rejects.toThrow('already using')
    } finally {
      lease.release()
    }
    expect(inspectInstallationUpdate(f.location)).toBeDefined()
  }
)
it('refuses an active executor lock or another installation process', async () => {
  const f = fixture(),
    directory = handoff(f),
    db = new DatabaseSync(join(directory, 'executor.sqlite'))
  db.exec('BEGIN EXCLUSIVE')
  try {
    await expect(
      recoverInstallationAfterSystemRestart(f.location, f.record.operationId, f.options)
    ).rejects.toThrow()
  } finally {
    db.close()
  }
  await expect(
    recoverInstallationAfterSystemRestart(f.location, f.record.operationId, {
      ...f.options,
      inspectProcesses: async () => [987654]
    })
  ).rejects.toThrow('Another process')
  expect(inspectInstallationUpdate(f.location)).toBeDefined()
})
