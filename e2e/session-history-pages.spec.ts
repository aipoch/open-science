import { expect } from '@playwright/test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  resolveActiveConversationActivities,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages,
  validateConversationGraph
} from '../src/shared/conversation-graph'
import type { PersistedChatSession, PersistedToolActivity } from '../src/shared/session-persistence'

const legacyJsonFixturePath = join(
  __dirname,
  'fixtures',
  'legacy-json',
  'open-science-1.0.8-session.v2.json'
)

type LegacySessionFile = {
  version: number
  session: PersistedChatSession & {
    conversationGraph: NonNullable<PersistedChatSession['conversationGraph']> & {
      schemaVersion: number
    }
  }
}

const readLegacySessionFixture = async (): Promise<LegacySessionFile> =>
  JSON.parse(await readFile(legacyJsonFixturePath, 'utf8')) as LegacySessionFile

// Guard the checked-in input itself: a current JSONL stream is multiple JSON documents and would
// fail this parse, while a regenerated current JSON file loses the released graph field shape.
test('keeps the checked-in legacy JSON fixture as a released 1.0.8 v2 envelope', async () => {
  const fixture = await readLegacySessionFixture()
  expect(fixture.version).toBe(2)
  expect(fixture.session).toMatchObject({
    id: 'legacy-upgrade-json-session',
    number: 1,
    revision: 1,
    title: 'Legacy JSON upgrade session',
    status: 'idle',
    agentFrameworkId: 'opencode',
    permissionProfile: 'ask',
    autoReviewEnabled: false,
    memoryEnabled: true,
    delegationPolicy: 'allow'
  })
  expect(fixture.session.agentConfiguration).toBeUndefined()
  expect(
    fixture.session.messages.map(({ id, role, responseToMessageId }) => ({
      id,
      role,
      responseToMessageId
    }))
  ).toEqual([
    { id: 'legacy-upgrade-question', role: 'user', responseToMessageId: undefined },
    {
      id: 'legacy-upgrade-answer',
      role: 'agent',
      responseToMessageId: 'legacy-upgrade-question'
    }
  ])
  expect(fixture.session.conversationGraph).toMatchObject({
    schemaVersion: 1,
    rootFrameId: 'root-frame-legacy-upgrade-json-session',
    activeFrameId: 'root-frame-legacy-upgrade-json-session'
  })
  expect(fixture.session.conversationGraph.frames).toHaveLength(1)
  expect(fixture.session.conversationGraph.branches).toHaveLength(1)
  expect(fixture.session.conversationGraph.messages.map(({ id }) => id)).toEqual([
    'legacy-upgrade-question',
    'legacy-upgrade-answer'
  ])
})

test('continues and cold opens legacy JSON alongside new JSONL without migrating or indexing the legacy conversation', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const cwd = await app.createTestDirectory('legacy-history')
  const projectName = 'Legacy conversation history'
  const projectId = await page.evaluate(
    async (name) => (await window.api.projects.create({ name, description: '' })).id,
    projectName
  )
  const configuration = await page.evaluate(async () => {
    const settings = await window.api.settings.getSettings()
    if (!settings.activeProviderId) throw new Error('No configured fixture provider.')
    return {
      providerId: settings.activeProviderId,
      model: settings.activeModel,
      reasoningEffort: settings.reasoningEffort
    }
  })
  // Seed the released 1.0.8 file unchanged except for runtime identity fields: projectId, cwd, and
  // the provider binding the fake agent needs. Everything else — envelope version, graph, message
  // IDs, and timestamps — comes from the checked-in sample.
  const legacyFile = await readLegacySessionFixture()
  const source = legacyFile.session
  source.projectId = projectId
  source.cwd = cwd
  // Supply the provider binding needed to continue the released conversation with the fake agent.
  source.agentConfiguration = configuration
  const expectedJson = JSON.stringify(legacyFile)
  page = await app.restartWithRawSessionFileFixture({
    projectId,
    sessionId: source.id,
    contents: expectedJson
  })
  const application = (app as unknown as { application: ElectronApplication }).application
  const configRoot = await application.evaluate(() => process.env.OPEN_SCIENCE_CONFIG_ROOT!)
  const directory = join(configRoot, 'sessions', projectId)
  const legacyPath = join(directory, `${source.id}.json`)
  await openProjectSession(page, projectName, source.title)
  await expect(page.getByText(source.messages[0].content, { exact: true })).toBeVisible()
  await expect(page.getByText(source.messages[1].content, { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Load full conversation', exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Load earlier messages', exact: true })
  ).toHaveCount(0)
  // Inspect the durable file after all renderer writes have settled.
  const flushed = await application.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const requestId = 'legacy-read-flush'
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('sessions:flush-response', respond)
        reject(new Error('Legacy read flush did not complete.'))
      }, 10_000)
      const respond = (
        _event: Electron.IpcMainEvent,
        response: { requestId: string; status: string }
      ): void => {
        if (response.requestId !== requestId) return
        clearTimeout(timer)
        ipcMain.removeListener('sessions:flush-response', respond)
        resolve(response.status)
      }
      ipcMain.on('sessions:flush-response', respond)
      BrowserWindow.getAllWindows()[0].webContents.send('sessions:flush-request', { requestId })
    })
  })
  expect(flushed).toBe('completed')
  const opened = JSON.parse(await readFile(legacyPath, 'utf8')) as LegacySessionFile
  // A first-open save can materialize display defaults, including a new optimistic revision.
  expect(opened).toEqual(
    opened.session.revision === source.revision
      ? legacyFile
      : {
          ...legacyFile,
          session: { ...source, description: '', filesRevision: 0, revision: source.revision! + 1 }
        }
  )
  expect((await readdir(directory)).filter((name) => name.startsWith(source.id))).toEqual([
    `${source.id}.json`
  ])
  const readLegacyIndexCounts = (): Promise<unknown[]> =>
    (app as unknown as { application: ElectronApplication }).application.evaluate(
      (_electron, { configRoot, sessionId }) => {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
        const db = new DatabaseSync(
          process.getBuiltinModule('node:path').join(configRoot, 'open-science.db'),
          { readOnly: true }
        )
        try {
          return ['SessionHistoryIndex', 'SessionHistoryItem'].map(
            (table) =>
              db
                .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE "sessionId" = ?`)
                .get(sessionId)?.count
          )
        } finally {
          db.close()
        }
      },
      { configRoot, sessionId: source.id }
    )
  const indexCounts = await readLegacyIndexCounts()
  expect(indexCounts).toEqual([0, 0])
  await writeFile(
    testInfo.outputPath('legacy-json-read-evidence.json'),
    JSON.stringify(
      { revision: opened.session.revision, indexCounts, files: await readdir(directory) },
      null,
      2
    )
  )
  await page.screenshot({ path: testInfo.outputPath('legacy-json-opened.png') })

  const followup = 'Continue the historical JSON conversation.'
  await submitPromptViaUi(page, followup)
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
  ).toBeVisible()
  await expect
    .poll(async () => {
      const saved = await page.evaluate(
        ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
        source
      )
      return {
        status: saved?.status,
        followups: saved?.messages.filter(({ content }) => content === followup).length,
        outcome: saved?.messages.find(({ content }) => content === followup)?.turnOutcome?.kind
      }
    })
    .toEqual({ status: 'idle', followups: 1, outcome: 'completed' })
  const continued = await page.evaluate(
    ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
    source
  )
  expect(continued?.messages.filter(({ id }) => id.startsWith('legacy-'))).toEqual(source.messages)
  expect((await readdir(directory)).filter((name) => name.startsWith(source.id))).toEqual([
    `${source.id}.json`
  ])
  expect(await readLegacyIndexCounts()).toEqual([0, 0])

  // Both formats share the renderer API; only the new identity starts a JSONL history.
  const modern: PersistedChatSession = {
    ...source,
    id: 'new-history-session',
    number: undefined,
    revision: undefined,
    title: 'New JSONL research',
    agentConfiguration: configuration,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    conversationGraph: undefined,
    activities: undefined,
    messages: source.messages.map((message) => ({
      ...message,
      id: message.id.replace('legacy-', 'new-'),
      responseToMessageId: message.responseToMessageId?.replace('legacy-', 'new-'),
      content: message.content.replace('LEGACY-', 'NEW-')
    }))
  }
  await page.evaluate((session) => window.api.sessions.saveSession(session), modern)
  page = await app.restart()
  await openProjectSession(page, projectName, modern.title)
  await expect(page.getByText(modern.messages[1].content, { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Load full conversation', exact: true })
  ).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .locator('button[data-slot="session-open-button"]')
    .filter({ hasText: source.title })
    .click()
  await expect(page.getByText(source.messages[0].content, { exact: true })).toBeVisible()
  await expect(page.getByText(source.messages[1].content, { exact: true })).toBeVisible()
  await expect(page.getByText(followup, { exact: true })).toBeVisible()
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Load full conversation', exact: true })
  ).toHaveCount(0)
  const cold = await page.evaluate(
    ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
    source
  )
  expect(cold?.messages).toEqual(continued?.messages)
  expect(cold?.activities).toEqual(continued?.activities)
  expect(cold?.conversationGraph).toEqual(continued?.conversationGraph)
  // Startup may load the selected conversation before the renderer becomes available to the test.
  const pageKinds = await page.evaluate(
    async ({ projectId, sessionIds }) => {
      return Promise.all(
        sessionIds.map(async (sessionId) => {
          const result = await window.api.sessions.loadHistoryPage({ projectId, sessionId })
          return { sessionId: result?.sessionId, complete: result?.complete }
        })
      )
    },
    { projectId, sessionIds: [modern.id, source.id] }
  )
  expect(pageKinds).toEqual([
    { sessionId: modern.id, complete: undefined },
    { sessionId: source.id, complete: true }
  ])
  expect((await readdir(directory)).filter((name) => name.startsWith(source.id))).toEqual([
    `${source.id}.json`
  ])
  expect((await readdir(directory)).filter((name) => name.startsWith(modern.id))).toEqual([
    `${modern.id}.jsonl`
  ])
  expect(await readLegacyIndexCounts()).toEqual([0, 0])
  await writeFile(
    testInfo.outputPath('mixed-format-continuation-evidence.json'),
    JSON.stringify(
      {
        pageKinds,
        legacyIndexCounts: await readLegacyIndexCounts(),
        files: await readdir(directory),
        legacyMessageCountBefore: source.messages.length,
        legacyMessageCountAfter: cold?.messages.length
      },
      null,
      2
    )
  )
  await page.screenshot({ path: testInfo.outputPath('legacy-json-cold-continued.png') })
})

for (const branched of [false, true]) {
  test(
    branched
      ? 'cold opens complete branched JSONL with revision navigation and preserves branches when continuing'
      : 'pages real Electron history and loads authority before continuing without losing older records',
    async ({ app }, testInfo) => {
      test.setTimeout(180_000)
      await app.completeOnboarding()
      let page = await app.configureFakeAgent()
      // This fixture owns its title across the continuation and cold-open assertions.
      await page.evaluate(() =>
        window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
      )
      const cwd = await app.createTestDirectory('paged-history')
      const projectName = 'Paged conversation history'
      const projectId = await page.evaluate(
        async (name) => (await window.api.projects.create({ name, description: '' })).id,
        projectName
      )
      const id = 'paged-history-session'
      const now = Date.now() - 20_000
      const activities: PersistedToolActivity[] = []
      const session: PersistedChatSession = {
        id,
        projectId,
        cwd,
        title: 'Twelve turns and complete tool results',
        status: 'idle',
        agentFrameworkId: 'opencode',
        createdAt: now,
        updatedAt: now + 1_200,
        messages: Array.from({ length: 12 }, (_, turn) => {
          for (let call = 0; call < 10; call++)
            activities.push({
              id: `paged-tool-${turn}-${call}`,
              kind: 'tool',
              title: 'Read fixture',
              providerToolName: 'read_file',
              toolKind: 'read',
              status: 'completed',
              sortIndex: turn * 2 + 1,
              eventIds: [],
              promptMessageId: `paged-prompt-${turn}`,
              createdAt: now + turn * 100 + call + 1,
              updatedAt: now + turn * 100 + call + 2,
              rawInput: { path: `fixture-${turn}-${call}.txt` },
              rawOutput: {
                text: `Tool record ${turn}/${call}\n${'Complete scientific result. '.repeat(300)}`
              }
            })
          return [
            {
              id: `paged-prompt-${turn}`,
              role: 'user' as const,
              content: `PAGED-PROMPT-${turn}`,
              status: 'complete' as const,
              eventIds: [],
              createdAt: now + turn * 100,
              updatedAt: now + turn * 100
            },
            {
              id: `paged-reply-${turn}`,
              role: 'agent' as const,
              content: `PAGED-REPLY-${turn}`,
              responseToMessageId: `paged-prompt-${turn}`,
              status: 'complete' as const,
              eventIds: [],
              createdAt: now + turn * 100 + 90,
              updatedAt: now + turn * 100 + 90
            }
          ]
        }).flat(),
        activities
      }
      let graph = synchronizeActiveConversationActivities(
        createLinearConversationGraph({
          sessionId: id,
          frameworkId: 'opencode',
          messages: session.messages,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        }),
        activities,
        []
      )
      if (branched) {
        const originalBranch = graph.frames[0].activeBranchId
        graph = forkEditedConversationMessage(
          graph,
          'paged-prompt-11',
          'paged-alternate',
          session.updatedAt + 1
        )
        graph = synchronizeActiveConversationMessages(
          graph,
          [
            {
              ...session.messages[22],
              id: 'paged-revised-prompt-11',
              content: 'An alternate research question',
              createdAt: session.updatedAt + 2,
              updatedAt: session.updatedAt + 2
            }
          ],
          session.updatedAt + 2
        )
        graph = activateConversationBranch(graph, originalBranch)
      }
      validateConversationGraph(graph)
      session.conversationGraph = graph
      // Match the app's canonical flat projection; prompt/branch ownership lives on graph activities.
      session.activities = resolveActiveConversationActivities(graph).activities
      const baseline = await page.evaluate(
        (fixture) => window.api.sessions.saveSession(fixture),
        session
      )
      page = await app.restart()

      // Observe the actual preload→Main calls, without replacing storage results or renderer state.
      let application = (app as unknown as { application: ElectronApplication }).application
      const installReadProbe = (): Promise<void> =>
        application.evaluate(({ ipcMain }) => {
          const calls: string[] = []
          Reflect.set(globalThis, 'sessionHistoryReadProbe', calls)
          const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
            string,
            (...args: unknown[]) => unknown
          >
          for (const channel of ['sessions:load-history-page', 'sessions:load-one']) {
            const original = handlers.get(channel)
            if (!original) throw new Error(`Missing real history handler: ${channel}`)
            handlers.set(channel, async (...args) => {
              calls.push(channel)
              const result = await original(...args)
              if (channel === 'sessions:load-history-page')
                Reflect.set(globalThis, 'sessionHistoryLastPage', result)
              return result
            })
          }
        })
      await installReadProbe()
      const readCalls = (): Promise<string[]> =>
        application.evaluate(() => Reflect.get(globalThis, 'sessionHistoryReadProbe') as string[])

      await openProjectSession(page, projectName, session.title)
      await expect(page.getByText('PAGED-REPLY-11', { exact: true })).toBeVisible()
      expect(await readCalls()).toContain('sessions:load-history-page')
      expect(await readCalls()).not.toContain('sessions:load-one')
      const firstPageCalls = await readCalls()
      let pagedCalls: string[] = []
      let completeCalls: string[] = []
      if (branched) {
        // The full fallback keeps graph-based navigation available on the first cold open.
        await expect(page.getByText('PAGED-PROMPT-0', { exact: true })).toBeVisible()
        await expect(page.getByLabel('Message revision', { exact: true })).toHaveText('1/2')
        await expect(
          page.getByRole('button', { name: 'Next message revision', exact: true })
        ).toBeEnabled()
        await expect(
          page.getByRole('button', { name: 'Load earlier messages', exact: true })
        ).toHaveCount(0)
        await expect(
          page.getByRole('button', { name: 'Load full conversation', exact: true })
        ).toHaveCount(0)
        const response = await application.evaluate(() =>
          Reflect.get(globalThis, 'sessionHistoryLastPage')
        )
        expect(response.complete).toBe(true)
        expect(response.session.messages).toEqual(baseline.messages)
        expect(response.session.activities).toEqual(baseline.activities)
        expect(response.session.conversationGraph).toEqual(baseline.conversationGraph)
        completeCalls = await readCalls()
      } else {
        await expect(page.locator('[data-message-id="paged-prompt-0"]')).toHaveCount(0)
        await expect(
          page.getByRole('button', { name: 'Next message revision', exact: true })
        ).toHaveCount(0)
        await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
        await expect(page.getByText('PAGED-PROMPT-0', { exact: true })).toBeVisible()
        await expect(
          page.getByRole('button', { name: 'Load earlier messages', exact: true })
        ).toHaveCount(0)
        expect(await readCalls()).not.toContain('sessions:load-one')
        await expect(
          page.getByRole('button', { name: 'Load full conversation', exact: true })
        ).toBeVisible()
        pagedCalls = await readCalls()

        await page.getByRole('button', { name: 'Load full conversation', exact: true }).click()
        await expect(
          page.getByRole('button', { name: 'Load full conversation', exact: true })
        ).toHaveCount(0)
        await expect(
          page.getByRole('button', { name: 'Next message revision', exact: true })
        ).toHaveCount(0)
        expect(await readCalls()).toContain('sessions:load-one')
        completeCalls = await readCalls()

        // Return to a cold, display-only page; sending itself must fetch full authority.
        page = await app.restart()
        application = (app as unknown as { application: ElectronApplication }).application
        await installReadProbe()
        await openProjectSession(page, projectName, session.title)
        await expect(
          page.getByRole('button', { name: 'Load full conversation', exact: true })
        ).toBeVisible()
        expect(await readCalls()).not.toContain('sessions:load-one')
      }

      const followup = 'Continue after reading the paged scientific history.'
      await submitPromptViaUi(page, followup)
      // The fake provider's default scenario returns this fixed response for every prompt.
      await expect(
        page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
      ).toBeVisible()
      if (!branched) expect(await readCalls()).toContain('sessions:load-one')
      await expect
        .poll(async () => {
          const saved = await page.evaluate(
            ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
            { projectId, id }
          )
          return {
            status: saved?.status,
            followups: saved?.messages.filter((message) => message.content === followup).length
          }
        })
        .toEqual({ status: 'idle', followups: 1 })
      const saved = await page.evaluate(
        ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
        { projectId, id }
      )
      expect(saved?.messages.filter(({ id }) => id.startsWith('paged-'))).toEqual(baseline.messages)
      expect(saved?.activities).toEqual(baseline.activities)
      expect(saved?.conversationGraph?.activities).toEqual(baseline.conversationGraph?.activities)
      expect(saved?.conversationGraph?.branches.map(({ id }) => id)).toEqual(
        graph.branches.map(({ id }) => id)
      )
      expect(saved?.conversationGraph?.messages.map(({ id }) => id)).toEqual(
        expect.arrayContaining(graph.messages.map(({ id }) => id))
      )
      if (branched) {
        expect(
          saved?.conversationGraph?.branches.find(({ id }) => id === 'paged-alternate')
        ).toEqual(baseline.conversationGraph?.branches.find(({ id }) => id === 'paged-alternate'))
        expect(
          saved?.conversationGraph?.messages.find(({ id }) => id === 'paged-revised-prompt-11')
        ).toEqual(
          baseline.conversationGraph?.messages.find(({ id }) => id === 'paged-revised-prompt-11')
        )
      }
      await testInfo.attach('history-page-ipc-evidence', {
        body: JSON.stringify(
          {
            branched,
            activeMessages: 24,
            tools: 120,
            totalBusinessRecords: 144,
            firstPageCalls,
            pagedCalls,
            completeCalls,
            allCalls: await readCalls(),
            originalGraphMessages: graph.messages.length,
            savedGraphMessages: saved?.conversationGraph?.messages.length
          },
          null,
          2
        ),
        contentType: 'application/json'
      })
      await page.screenshot({ path: testInfo.outputPath('paged-history-continued.png') })

      page = await app.restart()
      await openProjectSession(page, projectName, saved!.title)
      await expect(page.getByText(followup, { exact: true })).toBeVisible()
      if (branched) {
        await expect(page.getByLabel('Message revision', { exact: true })).toHaveText('1/2')
        await expect(
          page.getByRole('button', { name: 'Load full conversation', exact: true })
        ).toHaveCount(0)
      }
      const cold = await page.evaluate(
        ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
        { projectId, id }
      )
      expect(cold?.messages).toEqual(saved?.messages)
      expect(cold?.activities).toEqual(saved?.activities)
      expect(cold?.conversationGraph).toEqual(saved?.conversationGraph)
    }
  )
}
