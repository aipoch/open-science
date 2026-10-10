import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

// Real Electron/Notebook UI chain with deterministic OpenCode ACP, not a Claude provider test.
// The real Claude ACP/SDK process contract lives in specialist-switch-recovery.integration.test.ts.
test('deterministic OpenCode Electron Notebook handoffs settle and repeated picker switches preserve drafts', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Specialist switch recovery')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const specialist = await page.evaluate(async () => {
    const skills = await window.api.settings.createSkill({
      name: 'switch-regression-skill',
      description: 'Exercise Specialist-owned skill release.',
      body: 'Complete the deterministic switch regression.'
    })
    const skill = skills.find((entry) => entry.name === 'switch-regression-skill')!
    await window.api.settings.setSkillEnabled({ id: skill.id, enabled: false })
    return window.api.specialist.create({
      name: 'SPECIALIST_SWITCH_FIXTURE',
      displayName: 'Switch fixture',
      description: 'Deterministic provider real Notebook handoff regression.',
      systemPrompt: 'Complete the switch regression.',
      capabilityMode: 'selected',
      selectedCapabilities: { skillIds: [skill.id], connectorIds: [], connectorTools: [] }
    })
  })
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  for (const [index, target] of ['SPECIALIST_SWITCH_FIXTURE', 'Main Agent'].entries()) {
    await composer.fill(`Run specialist switch regression: ${target}`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await composer.fill(`Retained handoff draft ${index}`)
    await expect(
      page.getByText(`Specialist switch execution completed: ${target}`, { exact: false })
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await expect(page.getByTestId('specialist-pending-switch-chip')).toBeHidden()
    await expect(page.getByText(/Specialist switch is pending for/)).toBeHidden()
    await expect(
      page.getByText('Handoff continuation start failed.', { exact: false })
    ).toBeHidden()
    await expect(composer).toHaveText(`Retained handoff draft ${index}`)
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const session = (await window.api.sessions.loadAll()).sessions[0]
          return {
            specialistId: session.specialistId ?? null,
            pending: session.specialistBindingPending ?? null
          }
        })
      )
      .toEqual({ specialistId: index === 0 ? specialist.id : null, pending: null })
  }
  for (let index = 0; index < 20; index++) {
    await composer.fill(`Retained picker draft ${index}`)
    await page.getByRole('button', { name: /Agent controls:/ }).click()
    await page.getByTestId('specialist-submenu-trigger').press('ArrowRight')
    await page.getByTestId(`specialist-option-${index % 2 === 0 ? specialist.id : 'none'}`).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const session = (await window.api.sessions.loadAll()).sessions[0]
          return {
            specialistId: session.specialistId ?? null,
            pending: session.specialistBindingPending ?? null
          }
        })
      )
      .toEqual({ specialistId: index % 2 === 0 ? specialist.id : null, pending: null })
    await expect(page.getByTestId('specialist-pending-switch-chip')).toBeHidden()
    await expect(page.getByText(/Specialist switch is pending for/)).toBeHidden()
    await expect(
      page.getByText('Handoff continuation start failed.', { exact: false })
    ).toBeHidden()
    await expect(composer).toHaveText(`Retained picker draft ${index}`)
  }
  await composer.fill('Verify specialist switch runtime remains usable.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByText('Specialist switch runtime remains usable.', { exact: true })
  ).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.api.sessions.loadAll()).sessions[0].messages.filter(
            (message) => message.role === 'user'
          ).length
      )
    )
    .toBe(3)
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const session = (await window.api.sessions.loadAll()).sessions[0]
        return {
          status: session.status,
          replies: session.messages
            .filter((message) => message.role === 'agent')
            .map((message) => message.content)
        }
      })
    )
    .toEqual({
      status: 'idle',
      replies: [
        'Specialist switch execution completed: SPECIALIST_SWITCH_FIXTURE',
        'Specialist switch execution completed: Main Agent',
        'Specialist switch runtime remains usable.'
      ]
    })
  const sessions = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  expect(sessions[0].messages.filter((message) => message.role === 'user')).toHaveLength(3)
  expect(sessions[0].specialistBindingPending).toBeUndefined()
  expect(sessions[0].specialistId).toBeUndefined()
  await writeFile(testInfo.outputPath('sessions.json'), JSON.stringify(sessions, null, 2))
  await page.screenshot({
    path: testInfo.outputPath('specialist-switch-completed.png'),
    fullPage: true
  })
  await app.captureMainLog('specialist-switch-recovery.log')
})
