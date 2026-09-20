import type { PersistedChatSession } from '../../src/shared/session-persistence'
import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

test.setTimeout(180_000)

test('retains an Artifact Version producer across Electron relaunch', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Artifact provenance evidence')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  const receipt = await page.getByText(/^Artifact provenance verified for session /).innerText()
  const identity = receipt.match(
    /^Artifact provenance verified for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid Artifact provenance receipt: ${receipt}`)
  const [, appSessionId, artifactId, versionId] = identity

  const readProvenance = (): Promise<unknown> =>
    page.evaluate(
      async ({ appSessionId, artifactId, projectId, versionId }) => {
        const bridge = globalThis as unknown as {
          api: {
            artifacts: {
              getVersionProvenance: (request: {
                projectId: string
                appSessionId: string
                artifactId: string
                versionId: string
              }) => Promise<unknown>
            }
          }
        }
        return bridge.api.artifacts.getVersionProvenance({
          projectId,
          appSessionId,
          artifactId,
          versionId
        })
      },
      { appSessionId: appSessionId!, artifactId: artifactId!, projectId, versionId: versionId! }
    )

  await expect.poll(readProvenance, { timeout: 30_000 }).toMatchObject({
    contentStatus: { state: 'available' },
    evidence: {
      producer: {
        state: 'available',
        producer_run_id: expect.any(String)
      }
    }
  })

  // Main owns the completed transcript before the UI permits the next turn. Sending again
  // exercises adoption of an existing Session and verifies one owner per immutable Version.
  const readOwnedSession = (): Promise<PersistedChatSession | undefined> =>
    page.evaluate(
      async (id) => (await window.api.sessions.loadAll()).sessions.find((entry) => entry.id === id),
      appSessionId!
    )
  await expect
    .poll(readOwnedSession)
    .toMatchObject({ runtimeTranscriptOwner: 'main', status: 'idle' })
  const first = await readOwnedSession()
  expect(first?.artifacts?.filter((entry) => entry.versionId === versionId)).toHaveLength(1)
  const firstOwners = first?.conversationGraph?.messages.filter((message) =>
    message.artifactIds?.includes(
      first!.artifacts!.find((entry) => entry.versionId === versionId)!.id
    )
  )
  expect(firstOwners).toHaveLength(1)
  expect(firstOwners?.[0].responseToMessageId).toBe(
    first?.runtimeTranscriptLastRun?.promptMessageId
  )

  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )
  await expect
    .poll(async () => (await readOwnedSession())?.runtimeTranscriptLastRun?.promptMessageId)
    .not.toBe(first?.runtimeTranscriptLastRun?.promptMessageId)
  const second = await readOwnedSession()
  expect(second?.status).toBe('idle')
  expect(second?.error).toBeUndefined()
  expect(second?.messages.filter((entry) => entry.role === 'user')).toHaveLength(2)
  expect(second?.messages.filter((entry) => entry.role === 'agent')).toHaveLength(2)
  expect(second?.artifacts).toHaveLength(2)
  expect(new Set(second?.artifacts?.map((entry) => entry.versionId)).size).toBe(2)
  for (const artifact of second?.artifacts ?? []) {
    expect(
      second?.conversationGraph?.messages.filter((message) =>
        message.artifactIds?.includes(artifact.id)
      )
    ).toHaveLength(1)
  }

  page = await app.restart()
  await expect.poll(readProvenance, { timeout: 30_000 }).toMatchObject({
    contentStatus: { state: 'available' }
  })
  expect((await readOwnedSession())?.conversationGraph?.messages).toEqual(
    second?.conversationGraph?.messages
  )
})
