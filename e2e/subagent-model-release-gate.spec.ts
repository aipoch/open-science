import { expect, type Page } from '@playwright/test'

import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

const TERMINAL_PROMPT = 'Run the production delegation terminal journey.'
const TERMINAL_REPLY = 'Production delegation reached a terminal result.'
const TERMINAL_CHILD = 'Certified delegated terminal'
const MODEL_CONTINUATION_CHILD = 'Model continuation child'
const SUBAGENT_PROVIDER_NAME = 'Subagent E2E provider'
const SUBAGENT_MODEL = 'cross-provider-e2e-model'
const MODEL_BATCH_PROMPT = 'Run the Subagent model batch journey.'
const MODEL_CONTINUATION_START_PROMPT = 'Start the Subagent model continuation journey.'
const MODEL_CONTINUATION_FINISH_PROMPT = 'Finish the Subagent model continuation journey.'
const MODEL_UNAVAILABLE_PROMPT = 'Verify the Subagent model unavailable journey.'
const MODEL_INHERITED_PROMPT = 'Run the inherited Subagent model journey.'
const MODEL_INHERITED_CHILD = 'Inherited Subagent model fixture'
const INHERITED_SPECIALIST_PROMPT = 'Run the production inherited Specialist delegation journey.'

const closeWorkspacePreviews = async (page: Page): Promise<void> => {
  for (const name of ['Close preview of Subagents', 'Close preview of Notebook']) {
    const close = page.getByRole('button', { name, exact: true })
    if (await close.isVisible().catch(() => false)) await close.click({ force: true })
  }
}

test('routes a Settings UI fixed model through production Delegation and Usage', async ({
  app
}) => {
  test.setTimeout(360_000)
  let page = await app.completeOnboarding()

  const providerId = await page.evaluate(
    async ({ model, providerName }) => {
      const snapshot = await window.api.settings.upsertProvider({
        type: 'custom',
        name: providerName,
        apiEndpoints: ['openai'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model,
        key: 'subagent-e2e-key',
        reasoningEffortPreset: 'standard-5'
      })
      const provider = snapshot.providers.find((candidate) => candidate.name === providerName)
      if (!provider) throw new Error('The cross-provider Subagent fixture was not persisted.')
      return provider.id
    },
    { model: SUBAGENT_MODEL, providerName: SUBAGENT_PROVIDER_NAME }
  )
  page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Model', exact: true })
    .click()
  // The Subagent selector now lives inside the collapsed Scenario models accordion row.
  await settings.getByRole('button', { name: 'Expand Subagent settings', exact: true }).click()
  const model = settings.getByRole('combobox', { name: 'Subagent model Model' })
  const effort = settings.getByRole('combobox', { name: 'Subagent model Reasoning effort' })
  await expect(model).toContainText('Same as main model')
  await expect(effort).toBeDisabled()

  await model.click()
  await page
    .getByRole('option', {
      name: `${SUBAGENT_MODEL} · ${SUBAGENT_PROVIDER_NAME}`
    })
    .click()
  await expect(model).toContainText(SUBAGENT_MODEL)
  await expect(effort).toContainText('Default')
  await effort.click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await expect(effort).toContainText('High')
  await settings.getByRole('button', { name: 'Close settings' }).click()

  await createProject(page, 'Subagent model release gate')
  await sendPrompt(page, TERMINAL_PROMPT, TERMINAL_REPLY, 120_000)

  const durableIdentity = await page.evaluate(
    async ({ childName }) => {
      const loaded = await window.api.sessions.loadAll()
      for (const session of loaded.sessions) {
        const frame = session.conversationGraph?.frames.find(
          (candidate) => candidate.delegateName === childName
        )
        const attempt = session.runtimeContext?.delegatedWork?.records
          .find((record) => record.agentFrameId === frame?.id)
          ?.attempts.at(-1)
        const segment = session.conversationGraph?.runtimeSegments.find(
          (candidate) => candidate.id === attempt?.runtimeSegmentIds.at(-1)
        )
        if (attempt) return { attempt: attempt.executionModel, segment }
      }
      return undefined
    },
    { childName: TERMINAL_CHILD }
  )
  expect(durableIdentity).toMatchObject({
    attempt: {
      frameworkId: 'opencode',
      providerId,
      model: SUBAGENT_MODEL,
      reasoningEffort: 'high'
    },
    segment: {
      frameworkId: 'opencode',
      backendId: `opencode:${providerId}`,
      model: SUBAGENT_MODEL
    }
  })

  await page.getByRole('button', { name: TERMINAL_CHILD }).click()
  const preview = page.getByRole('region', { name: 'Subagents' })
  const usage = preview.getByRole('button', { name: /Token usage .* for this response/ })
  await expect(usage).toHaveCount(1)
  await usage.click()
  await expect(
    page.getByRole('img', {
      name: `Model provider: ${SUBAGENT_PROVIDER_NAME}; model: ${SUBAGENT_MODEL}`
    })
  ).toBeVisible()
  await preview.getByRole('button', { name: 'Close Subagents preview' }).click()

  await sendPrompt(page, MODEL_BATCH_PROMPT, 'Subagent model batch completed.', 120_000)
  const batchModels = await page.evaluate(async () => {
    const sessions = (await window.api.sessions.loadAll()).sessions
    return sessions.flatMap((session) => {
      const frames = session.conversationGraph?.frames.filter((frame) =>
        frame.delegateName?.includes('batch ')
      )
      return (frames ?? []).flatMap(
        (frame) =>
          session.runtimeContext?.delegatedWork?.records
            .find((record) => record.agentFrameId === frame.id)
            ?.attempts.map((attempt) => attempt.executionModel) ?? []
      )
    })
  })
  expect(batchModels).toHaveLength(2)
  expect(batchModels).toEqual([
    expect.objectContaining({ providerId, model: SUBAGENT_MODEL, reasoningEffort: 'high' }),
    expect.objectContaining({ providerId, model: SUBAGENT_MODEL, reasoningEffort: 'high' })
  ])

  await sendPrompt(
    page,
    MODEL_CONTINUATION_START_PROMPT,
    'Subagent model initial Attempt completed.',
    120_000
  )
  await closeWorkspacePreviews(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Model', exact: true })
    .click()
  await settings.getByRole('button', { name: 'Expand Subagent settings', exact: true }).click()
  await settings.getByRole('combobox', { name: 'Subagent model Model' }).click()
  await page.getByRole('option', { name: 'Same as main model', exact: true }).click()
  await expect(settings.getByRole('combobox', { name: 'Subagent model Model' })).toContainText(
    'Same as main model'
  )
  await expect
    .poll(async () => (await page.evaluate(() => window.api.settings.getSettings())).subagentModel)
    .toEqual({ mode: 'inherit' })
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await sendPrompt(
    page,
    MODEL_CONTINUATION_FINISH_PROMPT,
    'Subagent model continuation completed.',
    120_000
  )
  const continuedModels = await page.evaluate(
    async ({ childName }) => {
      const sessions = (await window.api.sessions.loadAll()).sessions
      const candidates = sessions.flatMap((session) =>
        (session.conversationGraph?.frames ?? [])
          .filter((frame) => frame.delegateName === childName)
          .map((frame) => ({
            createdAt: frame.createdAt,
            attempts:
              session.runtimeContext?.delegatedWork?.records.find(
                (record) => record.agentFrameId === frame.id
              )?.attempts ?? []
          }))
      )
      return candidates.at(-1)?.attempts.map((attempt) => attempt.executionModel)
    },
    { childName: MODEL_CONTINUATION_CHILD }
  )
  expect(continuedModels).toHaveLength(2)
  expect(continuedModels).toEqual([
    expect.objectContaining({ providerId, model: SUBAGENT_MODEL, reasoningEffort: 'high' }),
    expect.objectContaining({ providerId, model: SUBAGENT_MODEL, reasoningEffort: 'high' })
  ])

  await closeWorkspacePreviews(page)

  const frameIdsBeforeInherited = await page.evaluate(async () =>
    (await window.api.sessions.loadAll()).sessions.flatMap((session) =>
      (session.conversationGraph?.frames ?? [])
        .filter((frame) => frame.kind === 'delegate')
        .map((frame) => frame.id)
    )
  )
  await sendPrompt(page, MODEL_INHERITED_PROMPT, 'Inherited Subagent model completed.', 120_000)
  const inheritedIdentity = await page.evaluate(
    async ({ childName, previousFrameIds }) => {
      const sessions = (await window.api.sessions.loadAll()).sessions
      const candidates = sessions.flatMap((session) => {
        const rootFrameId = session.conversationGraph?.rootFrameId
        const rootSegment = session.conversationGraph?.runtimeSegments
          .filter((segment) => segment.agentFrameId === rootFrameId)
          .at(-1)
        return (session.conversationGraph?.frames ?? [])
          .filter(
            (frame) => frame.delegateName === childName && !previousFrameIds.includes(frame.id)
          )
          .map((frame) => ({
            createdAt: frame.createdAt,
            rootSegment,
            attempt: session.runtimeContext?.delegatedWork?.records.find(
              (record) => record.agentFrameId === frame.id
            )?.attempts[0]?.executionModel
          }))
      })
      return candidates.at(-1)
    },
    { childName: MODEL_INHERITED_CHILD, previousFrameIds: frameIdsBeforeInherited }
  )
  expect(inheritedIdentity?.attempt).toMatchObject({
    backendId: inheritedIdentity?.rootSegment?.backendId,
    model: inheritedIdentity?.rootSegment?.model
  })
})

test('fails closed, restores the fixed model, and routes Specialist but not Active ownership', async ({
  app
}) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  let providerId = await page.evaluate(
    async ({ model, providerName }) => {
      const snapshot = await window.api.settings.upsertProvider({
        type: 'custom',
        name: providerName,
        apiEndpoints: ['openai'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model,
        key: 'subagent-e2e-key',
        reasoningEffortPreset: 'standard-5'
      })
      const provider = snapshot.providers.find((candidate) => candidate.name === providerName)
      if (!provider) throw new Error('The Subagent provider fixture was not persisted.')
      return provider.id
    },
    { model: SUBAGENT_MODEL, providerName: SUBAGENT_PROVIDER_NAME }
  )
  page = await app.configureFakeAgent()
  await page.evaluate(
    async ({ id, model }) =>
      window.api.settings.setSubagentModel({
        configuration: {
          mode: 'fixed',
          providerId: id,
          model,
          reasoningEffort: 'high'
        }
      }),
    { id: providerId, model: SUBAGENT_MODEL }
  )
  await createProject(page, 'Subagent unavailable release gate')
  const settings = page.getByRole('dialog', { name: 'Settings' })

  await closeWorkspacePreviews(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Model', exact: true })
    .click()
  await settings.getByRole('button', { name: 'Expand Subagent settings', exact: true }).click()
  await settings.getByRole('combobox', { name: 'Subagent model Model' }).click()
  await page.getByRole('option', { name: `${SUBAGENT_MODEL} · ${SUBAGENT_PROVIDER_NAME}` }).click()
  await settings.getByRole('button', { name: 'Close settings' }).click()
  const recordsBeforeUnavailable = await page.evaluate(async () =>
    (await window.api.sessions.loadAll()).sessions.reduce(
      (count, session) => count + (session.runtimeContext?.delegatedWork?.records.length ?? 0),
      0
    )
  )
  await page.evaluate(async (id) => window.api.settings.deleteProvider({ id }), providerId)
  await expect
    .poll(async () => (await page.evaluate(() => window.api.settings.getSettings())).subagentModel)
    .toEqual({
      mode: 'fixed',
      providerId,
      model: SUBAGENT_MODEL,
      reasoningEffort: 'high'
    })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Model', exact: true })
    .click()
  await settings.getByRole('button', { name: 'Expand Subagent settings', exact: true }).click()
  await expect(settings.getByRole('combobox', { name: 'Subagent model Model' })).toContainText(
    'Unavailable'
  )
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await sendPrompt(
    page,
    MODEL_UNAVAILABLE_PROMPT,
    'Unavailable Subagent model rejected the whole batch.',
    120_000
  )
  expect(
    await page.evaluate(async () =>
      (await window.api.sessions.loadAll()).sessions.reduce(
        (count, session) => count + (session.runtimeContext?.delegatedWork?.records.length ?? 0),
        0
      )
    )
  ).toBe(recordsBeforeUnavailable)
  providerId = await page.evaluate(
    async ({ id, model, providerName }) => {
      const restored = await window.api.settings.upsertProvider({
        id,
        type: 'custom',
        name: providerName,
        apiEndpoints: ['openai'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model,
        key: 'subagent-e2e-key',
        reasoningEffortPreset: 'standard-5'
      })
      const provider = restored.providers.find((candidate) => candidate.name === providerName)
      if (!provider) throw new Error('The restored Subagent provider was not persisted.')
      if (provider.id !== id) throw new Error('The restored provider identity changed.')
      const configuration = restored.subagentModel
      if (
        !configuration ||
        configuration.mode !== 'fixed' ||
        configuration.providerId !== id ||
        configuration.model !== model
      ) {
        throw new Error('The fixed Subagent reference did not recover automatically.')
      }
      return provider.id
    },
    { id: providerId, model: SUBAGENT_MODEL, providerName: SUBAGENT_PROVIDER_NAME }
  )
  await sendPrompt(page, TERMINAL_PROMPT, TERMINAL_REPLY, 120_000)

  const activeBeforeSpecialist = await page.evaluate(async () => {
    const snapshot = await window.api.settings.getSettings()
    return { providerId: snapshot.activeProviderId, model: snapshot.activeModel }
  })
  const specialist = await page.evaluate(async () =>
    window.api.specialist.create({
      name: 'MODEL_RELEASE_SPECIALIST',
      displayName: 'Release Specialist',
      description: 'Subagent model release identity.',
      systemPrompt: 'Preserve the Subagent model release identity.'
    })
  )
  await page.getByRole('button', { name: /Agent controls:/ }).click()
  await page.getByTestId('specialist-submenu-trigger').press('ArrowRight')
  await page.getByTestId(`specialist-option-${specialist.id}`).click()
  await sendPrompt(
    page,
    INHERITED_SPECIALIST_PROMPT,
    'Production inherited Specialist delegation completed.',
    120_000
  )
  const specialistAttempt = await page.evaluate(async (profileId) => {
    const sessions = (await window.api.sessions.loadAll()).sessions
    return sessions
      .flatMap((session) => session.runtimeContext?.delegatedWork?.records ?? [])
      .flatMap((record) => record.attempts)
      .find(
        (attempt) =>
          attempt.resolvedAgent.kind === 'specialist' &&
          attempt.resolvedAgent.profileId === profileId
      )
  }, specialist.id)
  expect(specialistAttempt).toMatchObject({
    resolvedAgent: { kind: 'specialist', profileId: specialist.id },
    executionModel: { providerId, model: SUBAGENT_MODEL }
  })
  expect(
    await page.evaluate(async () => {
      const snapshot = await window.api.settings.getSettings()
      return { providerId: snapshot.activeProviderId, model: snapshot.activeModel }
    })
  ).toEqual(activeBeforeSpecialist)

  await page.getByTestId('composer-plus-trigger').click()
  await page.getByTestId('menu-request-review').click()
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const current = (await window.api.sessions.loadAll()).sessions[0]
          if (!current) return undefined
          const reviews = await window.api.reviewer.getForSession({
            projectId: current.projectId,
            appSessionId: current.id
          })
          return reviews.find((review) => review.lifecycle === 'complete')?.model
        }),
      { timeout: 120_000 }
    )
    .toBe(activeBeforeSpecialist.model)
  expect(activeBeforeSpecialist.model).not.toBe(SUBAGENT_MODEL)
})
