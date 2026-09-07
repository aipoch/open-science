import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSpecialistApplicationOwner,
  registerSpecialistApplicationCommands,
  specialistApplicationCommandGroup
} from './application-commands'
import {
  createApplicationCommandRouter,
  type ApplicationCommand,
  type ApplicationInvocation
} from '../application-command-router'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { createWebCallerContext } from '../caller-context'
import { createUploadCommandOwner } from '../uploads/command-owner'
import { UploadRepository } from '../uploads/repository'
import { SpecialistRepository } from './repository'
import { SpecialistService } from './service'
import { SpecialistPackageService } from './package/service'
import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  type SpecialistPackageCandidatePreview,
  type SpecialistPackageInstallResult
} from '../../shared/specialist-package'
import type { SpecialistCatalogSnapshot } from '../../shared/specialist'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const clean of cleanup.splice(0).reverse()) await clean()
})
const zip = zipSync({
  'manifest.json': strToU8(
    JSON.stringify({
      schema_version: 1,
      id: 'web-research',
      version: '1.0.0',
      exported_with_app_version: '0.25.1'
    })
  ),
  'specialist.json': strToU8(
    JSON.stringify({
      name: 'Web Research',
      description: 'Reviews research.',
      system_prompt: 'Review the evidence.',
      skill_ids: [],
      connector_ids: []
    })
  )
})

type TestCaller = {
  release: () => void
  invocation: <const Args extends readonly unknown[]>(args: Args) => ApplicationInvocation<Args>
  invoke: <Result = unknown>(name: string, ...args: unknown[]) => Promise<Result>
}
type Fixture = {
  first: TestCaller
  second: TestCaller
  upload: (bytes?: Uint8Array, transferId?: string) => Promise<{ transferId: string }>
  uploads: ReturnType<typeof createUploadCommandOwner>
  packages: SpecialistPackageService
  root: string
  service: SpecialistService
  onProfilesChanged: ReturnType<typeof vi.fn>
}
const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'specialist-web-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const uploads = createUploadCommandOwner(new UploadRepository(root))
  const repository = new SpecialistRepository(root)
  const service = new SpecialistService(repository)
  const packages = new SpecialistPackageService({
    storageDir: root,
    repository,
    catalog: async () => ({
      appVersion: '0.25.1',
      builtinSkills: [],
      skills: [],
      connectorIds: [],
      protectedSpecialistIds: ['reviewer']
    })
  })
  const onProfilesChanged = vi.fn()
  const owner = createSpecialistApplicationOwner({ service, packages, uploads, onProfilesChanged })
  const router = createApplicationCommandRouter()
  registerSpecialistApplicationCommands(router.registrar, owner)
  cleanup.push(() => router.dispose())
  const leases = new ApplicationCallerLeaseRegistry()
  const caller = (id: string): TestCaller => {
    const context = createWebCallerContext(id, { location: 'remote' })
    const lease = leases.acquire(context)
    cleanup.push(() => lease.release())
    const invocation = <const Args extends readonly unknown[]>(
      args: Args
    ): ApplicationInvocation<Args> => ({
      callerContext: context,
      callerLease: lease.lease,
      args
    })
    return {
      release: () => lease.release(),
      invocation,
      invoke: <Result = unknown>(name: string, ...args: unknown[]): Promise<Result> =>
        router.dispatcher.invoke(
          specialistApplicationCommandGroup.commands.find(
            (command) => command.name === name
          )! as ApplicationCommand<string, readonly unknown[], Result>,
          invocation(args)
        )
    }
  }
  const first = caller('first')
  const second = caller('second')
  const upload = async (
    bytes: Uint8Array = zip,
    transferId = 'package-one'
  ): Promise<{ transferId: string }> => {
    await first.invoke('specialist:package-upload-begin', {
      transferId,
      name: 'research.zip',
      size: bytes.length
    })
    await uploads.appendTransfer(first.invocation([{ transferId, offset: 0, chunk: bytes }]))
    return { transferId }
  }
  return { first, second, upload, uploads, packages, root, service, onProfilesChanged }
}

describe('Specialist Remote Web application commands', () => {
  it('uploads, previews, installs pending setup, configures and enables a Specialist through public commands', async () => {
    const f = await fixture()
    const request = await f.upload()
    const preview = await f.first.invoke<SpecialistPackageCandidatePreview>(
      'specialist:package-upload-preview',
      request
    )
    expect(preview.installable).toBe(true)
    expect(
      (await readdir(f.root, { recursive: true })).filter((path) => path.endsWith('.zip'))
    ).toEqual([])
    const installed = await f.first.invoke<SpecialistPackageInstallResult>(
      'specialist:package-install',
      { candidateToken: preview.candidateToken }
    )
    expect(installed).toMatchObject({
      status: 'installed',
      specialist: { setupPending: true, enabled: false }
    })
    if (installed.status !== 'installed') throw new Error('Expected installation')
    await f.first.invoke('specialist:update', {
      id: installed.specialist.id,
      revision: installed.specialist.revision,
      completeSetup: true
    })
    await f.first.invoke('specialist:set-enabled', { id: installed.specialist.id, enabled: true })
    const snapshot = await f.first.invoke<SpecialistCatalogSnapshot>('specialist:list')
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({ id: 'web-research', setupPending: false, enabled: true })
    )
    expect(f.onProfilesChanged).toHaveBeenCalledTimes(2)
  })

  it('rejects foreign upload handles and foreign candidate installation or cancellation', async () => {
    const f = await fixture()
    const request = await f.upload()
    await expect(f.second.invoke('specialist:package-upload-preview', request)).rejects.toThrow(
      /belong/
    )
    const preview = await f.first.invoke<SpecialistPackageCandidatePreview>(
      'specialist:package-upload-preview',
      request
    )
    await f.second.invoke('specialist:package-cancel', { candidateToken: preview.candidateToken })
    expect(
      await f.second.invoke('specialist:package-install', {
        candidateToken: preview.candidateToken
      })
    ).toMatchObject({ status: 'failed' })
    expect(
      await f.first.invoke('specialist:package-install', { candidateToken: preview.candidateToken })
    ).toMatchObject({ status: 'installed' })
  })

  it('rejects oversize declarations and arbitrary paths before staging or preview', async () => {
    const f = await fixture()
    await expect(
      f.first.invoke('specialist:package-upload-begin', {
        transferId: 'large',
        name: 'large.zip',
        size: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes + 1
      })
    ).rejects.toThrow()
    expect(await f.uploads.transferStatus(f.first.invocation([{ transferId: 'large' }]))).toBeNull()
    await expect(
      f.first.invoke('specialist:package-upload-preview', {
        transferId: 'fake',
        path: join(f.root, 'private.zip')
      })
    ).rejects.toThrow()
  })

  it('keeps archive validation and removes malformed completed ZIPs', async () => {
    const f = await fixture()
    const request = await f.upload(strToU8('not a ZIP'))
    const preview = await f.first.invoke<SpecialistPackageCandidatePreview>(
      'specialist:package-upload-preview',
      request
    )
    expect(preview.installable).toBe(false)
    expect(
      (await readdir(f.root, { recursive: true })).filter((path) => path.endsWith('.zip'))
    ).toEqual([])
    await expect(f.first.invoke('specialist:package-upload-preview', request)).rejects.toThrow(
      /belong/
    )
  })

  it('aborts partial uploads explicitly and expires candidates without installing', async () => {
    const f = await fixture()
    const request = await f.upload()
    await f.first.invoke('specialist:package-upload-abort', request)
    await expect(f.first.invoke('specialist:package-upload-preview', request)).rejects.toThrow(
      /belong/
    )
    const next = await f.upload(zip, 'package-two')
    const previewCall = vi.spyOn(f.packages, 'preview')
    const preview = await f.first.invoke<SpecialistPackageCandidatePreview>(
      'specialist:package-upload-preview',
      next
    )
    const ownerId = previewCall.mock.calls[0][1]
    expect(f.packages.report(preview.candidateToken, ownerId)).toBeDefined()
    f.first.release()
    expect(f.packages.report(preview.candidateToken, ownerId)).toBeUndefined()
    expect(
      (await f.service.listForSettingsSnapshot()).items.some((item) => item.id === 'web-research')
    ).toBe(false)
  })

  it('expires an idle preview and rejects its old candidate at installation', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const request = await f.upload()
    const preview = await f.first.invoke<SpecialistPackageCandidatePreview>(
      'specialist:package-upload-preview',
      request
    )
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(
      await f.first.invoke('specialist:package-install', { candidateToken: preview.candidateToken })
    ).toMatchObject({ status: 'failed', code: 'stale-candidate' })
  })

  it('removes an unfinished upload when its caller disconnects', async () => {
    const f = await fixture()
    await f.first.invoke('specialist:package-upload-begin', {
      transferId: 'partial',
      name: 'partial.zip',
      size: zip.length
    })
    await f.uploads.appendTransfer(
      f.first.invocation([{ transferId: 'partial', offset: 0, chunk: zip.slice(0, 10) }])
    )
    const files = async (): Promise<string[]> => {
      const paths = await readdir(f.root, { recursive: true })
      return paths.filter((path) => path.endsWith('.part'))
    }
    expect(await files()).toHaveLength(1)
    f.first.release()
    await vi.waitFor(async () => expect(await files()).toEqual([]))
  })
})
