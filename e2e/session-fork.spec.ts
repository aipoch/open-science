import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

test('forks local and imported research and immediately continues through the real desktop lifecycle', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.configureSessionPackageDialogs()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const project = page.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Fork lifecycle')
  await project.getByRole('button', { name: 'Create project' }).click()
  const prompt = 'Summarize the deterministic fixture.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await page.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  const title = `${prompt}(2)`
  await expect(page.getByRole('button', { name: `Open actions for ${title}` })).toBeVisible()
  const row = page
    .locator('[data-session-id]')
    .filter({ has: page.getByRole('button', { name: `Open actions for ${title}` }) })
  await expect(row.getByRole('img', { name: 'Read-only' })).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^#\d+.*\(2\)$/)
  const sourceLabel = await page
    .getByRole('button', { name: /^Continued from chat #\d+$/ })
    .innerText()
  const sourceNumber = sourceLabel.match(/#\d+$/)![0]
  await page.getByRole('button', { name: /^Continued from chat #\d+$/ }).click()
  await expect(page.getByRole('button', { name: /^Continued from chat #\d+$/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(sourceNumber)
  await row.locator('[data-slot="session-open-button"]').click()
  await expect(page.getByRole('button', { name: /^Continued from chat #\d+$/ })).toBeVisible()
  for (const [kind, followup] of [
    ['local', 'Continue local fork'],
    ['imported', 'Continue imported fork']
  ] as const) {
    if (kind === 'imported') {
      await page.getByRole('button', { name: `Open actions for ${title}` }).click()
      await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
      await page.getByRole('menuitem', { name: 'Export Session package', exact: true }).click()
      const exporting = page.getByRole('dialog', { name: 'Export Session package', exact: true })
      await exporting.getByRole('button', { name: 'Export', exact: true }).click()
      await expect(
        exporting.getByText('Package operation completed', { exact: true })
      ).toBeVisible()
      await exporting.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Fork lifecycle', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Import Session package…', exact: true }).click()
      const importing = page.getByRole('dialog', { name: 'Import Session package', exact: true })
      await importing.getByRole('button', { name: 'Import', exact: true }).click()
      await importing.getByRole('button', { name: 'Open imported Session', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Imported research history' })).toBeVisible()
      await page.getByRole('button', { name: 'Fork to continue', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Imported research history' })).toHaveCount(0)
    }
    const replies = page.getByText(`Deterministic reply: ${prompt}`, { exact: true })
    const previousReplies = await replies.count()
    await page.getByRole('textbox', { name: 'Ask anything' }).fill(followup)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(replies).toHaveCount(previousReplies + 1)
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
    await expect(page.getByText(/Project owner is unavailable/)).toHaveCount(0)
    await expect(page.getByText(/could not save the latest conversation changes/)).toHaveCount(0)
    await expect
      .poll(async () =>
        page.evaluate(
          async (text) =>
            (await window.api.sessions.loadAll()).sessions.some(
              (session) =>
                session.forkOrigin && session.messages.some((message) => message.content === text)
            ),
          followup
        )
      )
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${kind}-fork-continued.png`) })
  }
  const restarted = await app.restart()
  await restarted
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', {
      name: new RegExp('^Summarize the deterministic fixture\\.\\(2\\)\\(2\\)')
    })
    .click()
  await expect(restarted.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
  await expect(
    restarted
      .locator('[data-slot="session-open-button"][aria-current="page"]')
      .getByRole('img', { name: 'Read-only' })
  ).toHaveCount(0)
  const replies = restarted.getByText(`Deterministic reply: ${prompt}`, { exact: true })
  const before = await replies.count()
  await restarted.getByRole('textbox', { name: 'Ask anything' }).fill('Continue after restart')
  await restarted.getByRole('button', { name: 'Send message' }).click()
  await expect(replies).toHaveCount(before + 1)
  await expect(restarted.getByText(/Project owner is unavailable/)).toHaveCount(0)
  await expect
    .poll(async () =>
      restarted.evaluate(async () =>
        (await window.api.sessions.loadAll()).sessions.some(
          (session) =>
            session.forkOrigin &&
            session.messages.some((message) => message.content === 'Continue after restart')
        )
      )
    )
    .toBe(true)
})

test('changes branch permissions before the first follow-up without changing source permissions', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const project = page.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Branch permissions')
  await project.getByRole('button', { name: 'Create project' }).click()
  const prompt = 'Summarize the deterministic fixture.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  const reply = page.getByText(`Deterministic reply: ${prompt}`, { exact: true })
  // The first turn includes provider preparation on Windows. Wait for its actual durable
  // completion before checking paced text presentation; this is not a latency benchmark.
  await expect
    .poll(
      async () =>
        page.evaluate(async (prompt) => {
          const session = (await window.api.sessions.loadAll()).sessions.find((candidate) =>
            candidate.messages.some(
              (message) => message.role === 'user' && message.content === prompt
            )
          )
          return {
            status: session?.status,
            activeRun: Boolean(session?.activeRun),
            completedReply: session?.messages.some(
              (message) =>
                message.role === 'agent' &&
                message.status === 'complete' &&
                message.content === `Deterministic reply: ${prompt}`
            )
          }
        }, prompt),
      { timeout: 60_000 }
    )
    .toEqual({ status: 'idle', activeRun: false, completedReply: true })
  await expect(reply).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const source = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  const profile = source.permissionProfile === 'ask' ? 'auto' : 'ask'
  const label = profile === 'ask' ? 'Ask for approval' : 'Auto-approve edits'
  const sourceHeading = await page.getByRole('heading', { level: 1 }).innerText()
  await reply.hover()
  await page.getByRole('button', { name: 'Branch in new session', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(sourceHeading)
  const divider = page.getByRole('button', {
    name: `Continued from chat #${source.number}`,
    exact: true
  })
  await expect(divider).toBeVisible()
  // Isolated OpenCode Sessions start a new process. Wait for the temporary branch identity to bind
  // before opening a menu that is remounted when the durable Session id replaces it.
  await expect
    .poll(async () =>
      page.evaluate(
        async (sourceId) =>
          (await window.api.sessions.loadAll()).sessions.some(
            (session) =>
              session.branchSource?.sessionId === sourceId &&
              session.pendingHistoryReplay?.kind === 'all'
          ),
        source.id
      )
    )
    .toBe(true)

  await page.getByTestId('composer-controls-trigger').click()
  await page.getByRole('menuitem', { name: /^Permission mode/ }).hover()
  const option = page.getByRole('menuitem', { name: label, exact: true })
  await expect(option).not.toHaveAttribute('aria-disabled', 'true')
  await option.click()
  await expect(page.getByTestId('composer-controls-trigger')).toHaveAttribute(
    'aria-label',
    new RegExp(label)
  )
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ sourceId, profile }) => {
          const { sessions } = await window.api.sessions.loadAll()
          const child = sessions.find((session) => session.branchSource?.sessionId === sourceId)
          return child?.permissionProfile === profile && child.pendingHistoryReplay?.kind === 'all'
        },
        { sourceId: source.id, profile }
      )
    )
    .toBe(true)
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Continue the research')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(reply).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ sourceId, profile }) => {
          const { sessions } = await window.api.sessions.loadAll()
          const child = sessions.find((session) => session.branchSource?.sessionId === sourceId)
          return child?.permissionProfile === profile && child.pendingHistoryReplay === undefined
        },
        { sourceId: source.id, profile }
      )
    )
    .toBe(true)
  const original = await page.evaluate(
    async (id) =>
      (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id),
    source.id
  )
  expect(original?.permissionProfile).toBe(source.permissionProfile)
  expect(original?.messages).toEqual(source.messages)
  await expect(divider).toHaveCount(1)
  const followup = page.getByText('Continue the research', { exact: true })
  await expect
    .poll(async () => {
      const inheritedBox = await reply.first().boundingBox()
      const dividerBox = await divider.boundingBox()
      const followupBox = await followup.boundingBox()
      return Boolean(
        inheritedBox &&
        dividerBox &&
        followupBox &&
        inheritedBox.y < dividerBox.y &&
        dividerBox.y < followupBox.y
      )
    })
    .toBe(true)
  await divider.click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sourceHeading, {
    useInnerText: true
  })
  await expect(divider).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Continue from composer branch')
  await page.getByTestId('branch-send-menu-trigger').click()
  await page.getByTestId('menu-branch-in-new-session').click()
  await expect(divider).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(
        async (sourceId) =>
          (await window.api.sessions.loadAll()).sessions.some(
            (session) =>
              session.branchSource?.sessionId === sourceId &&
              session.status === 'idle' &&
              session.messages.some(
                (message) => message.content === 'Continue from composer branch'
              )
          ),
        source.id
      )
    )
    .toBe(true)
  const restarted = await app.restart()
  await restarted
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: /^Continue from composer branch/ })
    .click()
  await expect(
    restarted.getByRole('button', {
      name: `Continued from chat #${source.number}`,
      exact: true
    })
  ).toBeVisible()
})
