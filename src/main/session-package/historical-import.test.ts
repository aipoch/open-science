import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { initDataRoot } from '../storage-root'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
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
    source: { projectId: 'legacy-project', sessionId: 'legacy-session' },
    artifactCount: 0
  },
  {
    name: 'artifact package',
    path: fileURLToPath(
      new URL('./fixtures/session-package-v0.31.1-artifact.science', import.meta.url)
    ),
    sha256: 'd31f86381012eb7ae54b4ebe6ffca9510e7bc6049dd19e53e5206b7fbbcbcf24',
    projectName: 'Artifact research',
    source: { projectId: 'project-1', sessionId: 'session-1' },
    artifactCount: 1
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
        title: fixtureCase.projectName,
        status: 'idle',
        packageOrigin: {
          sourceProjectId: fixtureCase.source.projectId,
          sourceSessionId: fixtureCase.source.sessionId
        }
      })
      expect(origin.sourceManifest.source).toMatchObject(fixtureCase.source)
      expect(await target.client.artifactVersion.count()).toBe(fixtureCase.artifactCount)
    } finally {
      await service.close()
    }
  })
}
