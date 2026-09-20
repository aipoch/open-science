import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { initDataRoot } from '../storage-root'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPackageService } from './service'

const fixturePath = fileURLToPath(new URL('./fixtures/session-package-v1.science', import.meta.url))

const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

it('imports the checked-in Session package fixture', async () => {
  const target = await createProvenanceTestFixture()
  initDataRoot(target.storageRoot)
  fixtures.push(target)
  const service = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })

  try {
    const imported = await service.importFrom(fixturePath)
    const session = await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    const project = await target.client.project.findUniqueOrThrow({
      where: { id: imported.projectId }
    })

    expect(project.name).toBe('Legacy research')
    expect(session).toMatchObject({
      id: imported.sessionId,
      projectId: imported.projectId,
      title: 'Legacy research',
      status: 'idle',
      packageOrigin: {
        sourceProjectId: 'legacy-project',
        sourceSessionId: 'legacy-session'
      }
    })
  } finally {
    await service.close()
  }
})
