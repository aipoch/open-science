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

  page = await app.restart()
  await expect.poll(readProvenance, { timeout: 30_000 }).toMatchObject({
    contentStatus: { state: 'available' }
  })
})
