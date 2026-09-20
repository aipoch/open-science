import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { initDataRoot } from '../storage-root'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { sha256 } from '../artifacts/provenance-canonical'
import { createTestPdf } from '../../../test/fixtures/literature-pdf'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPackageService } from './service'

const fixturesUnderTest = [
  {
    name: 'minimal package',
    path: fileURLToPath(
      new URL('./fixtures/session-package-v0.31.1-minimal.science', import.meta.url)
    ),
    sha256: 'be6f0dad2957db20682501bb1affffa496a6e6a7dce739f418585bd303804123',
    projectName: 'Legacy research',
    sessionTitle: 'Legacy research',
    source: { projectId: 'legacy-project', sessionId: 'legacy-session' },
    artifactCount: 0,
    requiredFeatures: undefined,
    literatureItemCount: 0,
    literatureVersionCount: 0,
    pdfBytes: undefined
  },
  {
    name: 'artifact package',
    path: fileURLToPath(
      new URL('./fixtures/session-package-v0.31.1-artifact.science', import.meta.url)
    ),
    sha256: 'd31f86381012eb7ae54b4ebe6ffca9510e7bc6049dd19e53e5206b7fbbcbcf24',
    projectName: 'Artifact research',
    sessionTitle: 'Artifact research',
    source: { projectId: 'project-1', sessionId: 'session-1' },
    artifactCount: 1,
    requiredFeatures: undefined,
    literatureItemCount: 0,
    literatureVersionCount: 0,
    pdfBytes: undefined
  },
  {
    name: 'literature package',
    path: fileURLToPath(
      new URL('./fixtures/session-package-v0.31.1-literature.science', import.meta.url)
    ),
    sha256: '37b4c014151676aebc8c0866fc1f6b577bd5ad2976bd13b4b1412b18d9d256c8',
    projectName: 'Literature research',
    sessionTitle: 'Reading paper',
    source: { projectId: 'project-1', sessionId: 'session-1' },
    artifactCount: 0,
    requiredFeatures: ['literature'],
    literatureItemCount: 0,
    literatureVersionCount: 1,
    pdfBytes: createTestPdf()
  }
] as const

const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

for (const fixtureCase of fixturesUnderTest) {
  it(`imports the checked-in ${fixtureCase.name}`, async () => {
    const packageBytes = await readFile(fixtureCase.path)
    expect(createHash('sha256').update(packageBytes).digest('hex')).toBe(fixtureCase.sha256)

    const target = await createProvenanceTestFixture()
    initDataRoot(target.storageRoot)
    fixtures.push(target)
    const service = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })

    try {
      const imported = await service.importFrom(fixtureCase.path)
      const session = await new SessionRepository(target.storageRoot).loadSession(
        imported.projectId,
        imported.sessionId
      )
      const project = await target.client.project.findUniqueOrThrow({
        where: { id: imported.projectId }
      })
      const origin = await service.readOrigin(imported)

      expect(project.name).toBe(fixtureCase.projectName)
      expect(session).toMatchObject({
        id: imported.sessionId,
        projectId: imported.projectId,
        title: fixtureCase.sessionTitle,
        status: 'idle',
        packageOrigin: {
          sourceProjectId: fixtureCase.source.projectId,
          sourceSessionId: fixtureCase.source.sessionId
        }
      })
      expect(origin.sourceManifest.source).toMatchObject(fixtureCase.source)
      expect(origin.sourceManifest.requiredFeatures).toEqual(fixtureCase.requiredFeatures)
      expect(await target.client.artifactVersion.count()).toBe(fixtureCase.artifactCount)

      expect(await target.client.literatureItem.count()).toBe(fixtureCase.literatureItemCount)
      const literatureVersions = await target.client.uploadVersion.findMany({
        orderBy: { versionNumber: 'asc' }
      })
      expect(literatureVersions).toHaveLength(fixtureCase.literatureVersionCount)

      if (fixtureCase.pdfBytes) {
        const [version] = literatureVersions
        expect(version).toMatchObject({
          filename: 'paper.pdf',
          originalFilename: 'paper.pdf',
          contentType: 'application/pdf',
          checksum: sha256(fixtureCase.pdfBytes),
          sizeBytes: BigInt(fixtureCase.pdfBytes.length)
        })
        expect(await readFile(join(target.storageRoot, version.contentStorageKey))).toEqual(
          fixtureCase.pdfBytes
        )

        const binding = session?.runtimeContext?.pdfContext?.bindings[0]
        expect(binding).toMatchObject({
          sourceKind: 'literature-attachment-version',
          sourceFileId: version.uploadFileId,
          sourceVersionId: version.id,
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: fixtureCase.pdfBytes.length,
          checksum: sha256(fixtureCase.pdfBytes)
        })

        const recordsRoot = join(
          target.storageRoot,
          'artifacts',
          imported.projectId,
          imported.sessionId,
          '.session-package',
          'source'
        )
        const records = JSON.parse(await readFile(join(recordsRoot, 'records.json'), 'utf8'))
        expect(records.literature.items).toHaveLength(1)
        expect(records.literature.items[0]).toMatchObject({
          itemId: 'item-1',
          metadataRevision: 7,
          item: {
            itemType: 'journalArticle',
            title: 'Evidence paper',
            abstract: 'Abstract preserved with the PDF.',
            issuedText: '2024',
            issuedYear: 2024,
            containerTitle: 'Journal of Evidence',
            shortTitle: 'Evidence',
            language: 'en',
            rights: 'CC BY 4.0',
            url: 'https://example.test/evidence',
            accessedAt: 1_700_000_000_000,
            citationKey: 'evidence-2024',
            extra: 'Imported from fixture',
            rating: 4,
            personalNote: 'Read the methods section.',
            typeFields: { volume: '12', issue: '3', pages: '10-20' },
            creators: [
              {
                nameMode: 'person',
                givenName: 'Ada',
                familyName: 'Lovelace',
                creatorType: 'author'
              },
              {
                nameMode: 'organization',
                literalName: 'Evidence Institute',
                creatorType: 'publisher'
              }
            ],
            identifiers: [
              { scheme: 'doi', value: '10.1234/ABC', isPrimary: true },
              { scheme: 'pmid', value: '12345', isPrimary: false }
            ]
          }
        })
        expect(records.literature.attachments).toHaveLength(1)
        expect(records.literature.attachments[0]).toMatchObject({
          attachmentId: 'attachment-1',
          itemId: 'item-1',
          versionId: 'version-1'
        })
      }
    } finally {
      await service.close()
    }
  })
}
