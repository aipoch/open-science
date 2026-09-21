import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { PACKAGE_RO_CRATE_METADATA } from '../../shared/session-package'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from '../artifacts/provenance-test-fixtures'
import { sha256 } from '../artifacts/provenance-canonical'
import type { RoCrateMetadataDocument } from '../artifacts/ro-crate-export'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { packageEntry, readPackageArchive, writePackageArchive } from './archive'
import { SessionPackageService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
const services: SessionPackageService[] = []
const setup = async (): Promise<
  Awaited<ReturnType<typeof createProvenanceTestFixture>> & { service: SessionPackageService }
> => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  initDataRoot(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  services.push(service)
  return { ...fixture, service }
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
  initDataRoot(undefined)
})
const readMetadata = async (directory: string): Promise<RoCrateMetadataDocument> =>
  JSON.parse(await readFile(join(directory, PACKAGE_RO_CRATE_METADATA), 'utf8'))

it('exports checksummed RO-Crate metadata and rebuilds it after import with a narrower selection', async () => {
  const source = await setup(),
    target = await setup()
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Crate research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  for (const [index, filename] of ['one.png', 'two.png'].entries()) {
    await source.stagePng(`output ${index}`, filename)
    await source.repository.createVersion(
      createArtifactVersionRequest({ filename, writeOperationId: `write-${index}` })
    )
  }
  const archive = join(source.storageRoot, 'source.science')
  await source.service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const extracted = join(source.storageRoot, 'extracted')
  const manifest = await readPackageArchive(archive, extracted)
  const document = await readMetadata(extracted)
  expect(manifest.requiredFeatures).toContain('ro-crate')
  expect(manifest.inventory.filter((entry) => entry.kind === 'metadata')).toHaveLength(1)
  expect(
    manifest.inventory.find((entry) => entry.path === PACKAGE_RO_CRATE_METADATA)?.checksum
  ).toBe(sha256(await readFile(join(extracted, PACKAGE_RO_CRATE_METADATA))))
  for (const entity of document['@graph'].filter((entity) => entity['@type'] === 'File')) {
    const bytes = await readFile(join(extracted, entity['@id']))
    expect(entity.sha256).toBe(sha256(bytes))
    expect(entity.contentSize).toBe(String(bytes.byteLength))
  }
  expect(document['@graph'].filter((entity) => entity['@type'] === 'CreateAction')).toHaveLength(2)
  const omitted = await source.client.artifactVersion.findFirstOrThrow({
    where: { filename: 'two.png' }
  })
  const includedPath = manifest.inventory.find(
    (entry) => entry.storageKey === omitted.contentStorageKey
  )!.path
  document['@graph'].reverse()
  document['@graph'].find((entity) => entity['@id'] === './')!.description = 'Updated description'
  document['@graph'].push({ '@id': '#extra', '@type': 'CreativeWork', name: 'Extra context' })
  await writeFile(join(extracted, PACKAGE_RO_CRATE_METADATA), JSON.stringify(document))
  manifest.inventory = await Promise.all(
    manifest.inventory.map((entry) =>
      entry.kind === 'metadata' ? packageEntry(extracted, entry.path, 'metadata') : entry
    )
  )
  await writeFile(join(extracted, 'manifest.json'), JSON.stringify(manifest))
  const compatible = join(source.storageRoot, 'compatible.science')
  await writePackageArchive(extracted, compatible)
  const imported = await target.service.importFrom(compatible)
  const forwarded = join(target.storageRoot, 'forwarded.science')
  await target.service.exportTo(imported, forwarded, {
    selectFiles: async (files) =>
      files.filter((file) => file.filename === 'two.png').map((file) => file.storageKey)
  })
  const forwardedRoot = join(target.storageRoot, 'expanded')
  const forwardedManifest = await readPackageArchive(forwarded, forwardedRoot)
  const narrowed = await readMetadata(forwardedRoot)
  expect(forwardedManifest.inventory.some((entry) => entry.path === includedPath)).toBe(false)
  expect(JSON.stringify(narrowed)).not.toContain(includedPath)
  expect(
    narrowed['@graph'].find((entity) => entity['@id'] === `urn:open-science:version:${omitted.id}`)
  ).toMatchObject({ sha256: omitted.checksum, description: expect.stringContaining('excluded') })
  await expect(source.service.inspect(forwarded)).resolves.toMatchObject({
    title: 'Crate research'
  })

  // Recomputing the outer checksum must not authorize contradictory standard metadata.
  narrowed['@graph'].find((entity) => entity['@type'] === 'File')!.sha256 = sha256('wrong bytes')
  await writeFile(join(forwardedRoot, PACKAGE_RO_CRATE_METADATA), JSON.stringify(narrowed))
  forwardedManifest.inventory = await Promise.all(
    forwardedManifest.inventory.map((entry) =>
      entry.path === PACKAGE_RO_CRATE_METADATA
        ? packageEntry(forwardedRoot, entry.path, 'metadata')
        : entry
    )
  )
  await writeFile(join(forwardedRoot, 'manifest.json'), JSON.stringify(forwardedManifest))
  const tampered = join(target.storageRoot, 'tampered.science')
  await writePackageArchive(forwardedRoot, tampered)
  await expect(source.service.importFrom(tampered)).rejects.toThrow(
    'RO-Crate metadata does not match'
  )
})

it.each(['minimal', 'artifact', 'literature'])(
  'reads the historical %s fixture and adds metadata only to its new export',
  async (name) => {
    const target = await setup()
    const archive = fileURLToPath(
      new URL(`./fixtures/session-package-v0.31.1-${name}.science`, import.meta.url)
    )
    const before = await readFile(archive)
    const imported = await target.service.importFrom(archive)
    const forwarded = join(target.storageRoot, 'forwarded.science')
    await target.service.exportTo(imported, forwarded)
    const directory = join(target.storageRoot, 'expanded')
    const manifest = await readPackageArchive(forwarded, directory)
    expect(manifest.requiredFeatures).toContain('ro-crate')
    expect((await readMetadata(directory))['@graph'][0]['@id']).toBe(PACKAGE_RO_CRATE_METADATA)
    await expect(target.service.inspect(forwarded)).resolves.toHaveProperty('title')
    expect(await readFile(archive)).toEqual(before)
  }
)

it('rejects missing metadata and undeclared metadata while retaining strict archive paths', async () => {
  const target = await setup()
  const archive = fileURLToPath(
    new URL('./fixtures/session-package-v0.31.1-minimal.science', import.meta.url)
  )
  const imported = await target.service.importFrom(archive)
  const current = join(target.storageRoot, 'current.science')
  await target.service.exportTo(imported, current)
  const directory = join(target.storageRoot, 'expanded')
  const manifest = await readPackageArchive(current, directory)
  const absent = {
    ...manifest,
    inventory: manifest.inventory.filter((entry) => entry.path !== PACKAGE_RO_CRATE_METADATA)
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(absent))
  const invalid = join(target.storageRoot, 'missing.science')
  await writePackageArchive(directory, invalid)
  await expect(target.service.inspect(invalid)).rejects.toThrow(
    'RO-Crate package capability declaration'
  )
  manifest.requiredFeatures = manifest.requiredFeatures?.filter((feature) => feature !== 'ro-crate')
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  const undeclared = join(target.storageRoot, 'undeclared.science')
  await writePackageArchive(directory, undeclared)
  await expect(target.service.inspect(undeclared)).rejects.toThrow(
    'RO-Crate package capability declaration'
  )
})
