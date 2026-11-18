import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import { expectCompletedAssistant, submitPromptViaUi } from './fixtures/conversation'
import type { WebResult } from '../src/shared/web-tools'

type ModelRequest = {
  stream?: boolean
  messages: Array<{ role: string; content?: unknown }>
  tools?: Array<{ function: { name: string } }>
}
const initial = 'Read https://example.org/ and report PARENT_EVIDENCE_ONE_OK.'
const projectName = 'Web evidence branch lifecycle'
const openSession = async (page: Page, id: string): Promise<void> => {
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .locator(`[data-session-id="${id}"] [data-slot="session-open-button"]`)
    .click()
}
const deleteSession = async (page: Page, id: string): Promise<void> => {
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .locator(`[data-session-id="${id}"]`)
    .getByRole('button', { name: /^Open actions for/ })
    .click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Delete Session?' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(page.getByRole('alertdialog', { name: 'Delete Session?' })).toBeHidden()
}
const expandGroups = async (page: Page, expected: number): Promise<void> => {
  await expect(page.getByTestId('tool-group-header')).toHaveCount(expected)
  for (const group of await page.getByTestId('tool-group-header').all())
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click()
}

// Explicit public-network smoke; production URL/DNS/address/proxy validation remains enabled.
test('keeps full forks and message branches readable offline after parent deletion and collects the final reference', async ({
  app
}, testInfo) => {
  test.setTimeout(240000)
  const requests: ModelRequest[] = []
  const evidence: WebResult[] = []
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'web-lifecycle' }] }))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      )
      return
    }
    requests.push(body)
    const user = JSON.stringify(
      body.messages.findLast((message) => message.role === 'user')?.content
    )
    // A newly adopted provider Session can receive inherited prompts in its replay prefix.
    const command = ['PARENT_EVIDENCE_ONE', 'PARENT_LATE', 'CHILD_READ_LATE', 'CHILD_READ_OLD']
      .map((name) => ({ name, offset: user.lastIndexOf(name) }))
      .sort((left, right) => right.offset - left.offset)[0].name
    const marker = `${command}_OK`
    const call = body.messages.at(-1)?.role !== 'tool'
    if (!call) {
      const content = body.messages.at(-1)?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((block: { text?: string }) => block.text ?? '').join('\n')
            : ''
      try {
        evidence.push(JSON.parse(text) as WebResult)
      } catch {
        /* Assertions below require canonical tool envelopes. */
      }
    }
    const result =
      marker === 'CHILD_READ_LATE_OK'
        ? evidence.find((item) => item.request && 'refresh' in item.request && item.request.refresh)
        : evidence.find((item) => item.status === 'ok')
    const args = marker.startsWith('CHILD_')
      ? {
          snapshot_id: result!.document!.snapshot_id,
          cursor: result!.document!.next_cursor!,
          max_chars: 8000
        }
      : {
          url: 'https://example.org/',
          max_chars: 20,
          ...(marker === 'PARENT_LATE_OK' ? { refresh: true } : {})
        }
    const tool = body.tools?.find((item) => item.function.name.endsWith('__web_fetch'))
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `web-${requests.length}`,
              type: 'function',
              function: {
                name: tool?.function.name ?? 'missing_web_fetch',
                arguments: JSON.stringify(args)
              }
            }
          ]
        }
      : { content: marker }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  try {
    let page = await app.completeOnboarding()
    await page.evaluate(
      async (baseUrl) => {
        await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })

        const settings = await window.api.settings.upsertProvider({
          type: 'custom',
          name: 'Web lifecycle fixture',
          baseUrl,
          model: 'web-lifecycle',
          key: 'fixture',
          apiEndpoints: ['chat-completions'],
          contextWindow: 200000,
          maxOutputTokens: 4096
        })
        const provider = settings.providers.find((item) => item.name === 'Web lifecycle fixture')!
        await window.api.settings.setActiveProvider({ id: provider.id, model: provider.model! })
        await window.api.settings.setDefaultPermissionProfile({ profile: 'auto' })
        await window.api.settings.setAgentFramework({ id: 'open-science-agent' })
      },
      `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`
    )
    const projectId = await createProject(page, projectName)
    await submitPromptViaUi(page, initial)
    await expect(page.getByText('PARENT_EVIDENCE_ONE_OK', { exact: true })).toBeVisible({
      timeout: 90000
    })
    await expectCompletedAssistant(page, 'PARENT_EVIDENCE_ONE_OK')
    const parent = (
      await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((item) => item.projectId === projectId)!
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .locator(`[data-session-id="${parent.id}"]`)
      .getByRole('button', { name: /^Open actions for/ })
      .click()
    await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
    await expect
      .poll(async () =>
        (await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)).some(
          (item) => item.branchSource?.sessionId === parent.id && !!item.forkOrigin
        )
      )
      .toBe(true)
    const fork = (
      await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((item) => item.branchSource?.sessionId === parent.id && !!item.forkOrigin)!
    expect(requests).toHaveLength(2)
    await openSession(page, parent.id)
    await submitPromptViaUi(page, 'Refresh the webpage and report PARENT_LATE_OK.')
    await expect(page.getByText('PARENT_LATE_OK', { exact: true })).toBeVisible({ timeout: 90000 })
    await expectCompletedAssistant(page, 'PARENT_LATE_OK')
    expect(evidence[0].document!.snapshot_id).not.toBe(evidence[1].document!.snapshot_id)
    await openSession(page, fork.id)
    await submitPromptViaUi(
      page,
      'Use the supplied snapshot cursor for CHILD_READ_LATE, which belongs to the parent after this fork.'
    )
    await expect(page.getByText('CHILD_READ_LATE_OK', { exact: true })).toBeVisible({
      timeout: 90000
    })
    await expectCompletedAssistant(page, 'CHILD_READ_LATE_OK')
    expect(evidence.at(-1)?.error?.code).toBe('INVALID_CURSOR')
    await openSession(page, parent.id)
    await page.getByText('PARENT_EVIDENCE_ONE_OK', { exact: true }).hover()
    await page.getByRole('button', { name: 'Branch in new session', exact: true }).first().click()
    await expect
      .poll(async () =>
        (await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)).some(
          (item) => item.branchSource?.sessionId === parent.id && !item.forkOrigin
        )
      )
      .toBe(true)
    const branch = (
      await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((item) => item.branchSource?.sessionId === parent.id && !item.forkOrigin)!
    const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
    const root = join(dataRoot, 'web-evidence')
    const bodies = (await readdir(root, { recursive: true })).filter((name) =>
      /^[a-f0-9]{64}[\\/][a-f0-9-]{36}\.json$/.test(String(name))
    )
    const bodyPath = join(
      root,
      String(
        bodies.find((name) => String(name).endsWith(`${evidence[0].document!.snapshot_id}.json`))!
      )
    )
    const originalBody = await readFile(bodyPath, 'utf8')
    await deleteSession(page, parent.id)
    await expect
      .poll(async () =>
        (await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)).some(
          (item) => item.id === parent.id
        )
      )
      .toBe(false)
    expect(await readFile(bodyPath, 'utf8')).toBe(originalBody)
    await page.evaluate(async () => {
      await window.api.settings.setNetworkProxy({
        mode: 'manual',
        server: 'http://127.0.0.1:1',
        bypassRules: 'localhost,127.0.0.1'
      })
    })
    await openSession(page, fork.id)
    await submitPromptViaUi(page, 'Continue the inherited original snapshot for CHILD_READ_OLD.')
    await expect(page.getByText('CHILD_READ_OLD_OK', { exact: true })).toBeVisible({
      timeout: 90000
    })
    await expectCompletedAssistant(page, 'CHILD_READ_OLD_OK')
    expect(evidence.at(-1)?.document?.snapshot_id).toBe(evidence[0].document!.snapshot_id)
    expect(await readFile(bodyPath, 'utf8')).toBe(originalBody)
    await page.evaluate(async () => {})
    const requestsBeforeRestart = requests.length
    page = await app.restart()
    await page
      .getByRole('region', { name: 'Projects' })
      .getByRole('button', { name: projectName, exact: true })
      .click()
    await openSession(page, fork.id)
    await expandGroups(page, 3)
    const rows = page.getByTestId('tool-chip').filter({ hasText: 'Web Fetch' })
    await expect(rows).toHaveCount(3)
    await rows.last().click()
    await expect(page.getByTestId('tool-web-fetch-details').last()).toContainText(
      'documentation examples'
    )
    await page.screenshot({
      path: testInfo.outputPath('fork-after-parent-deletion-offline.png'),
      fullPage: true
    })
    await openSession(page, branch.id)
    await expandGroups(page, 1)
    const branchRow = page.getByTestId('tool-chip').filter({ hasText: 'Web Fetch' }).first()
    await branchRow.click()
    await expect(page.getByTestId('tool-web-fetch-details').first()).toContainText(
      'This domain is for u'
    )
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    expect(requests).toHaveLength(requestsBeforeRestart)
    expect(await readFile(bodyPath, 'utf8')).toBe(originalBody)
    await page.screenshot({
      path: testInfo.outputPath('message-branch-after-parent-deletion-offline.png'),
      fullPage: true
    })
    await deleteSession(page, fork.id)
    expect(await readFile(bodyPath, 'utf8')).toBe(originalBody)
    await deleteSession(page, branch.id)
    await expect
      .poll(async () =>
        readFile(bodyPath).then(
          () => true,
          () => false
        )
      )
      .toBe(false)
    await testInfo.attach('web-evidence-lifecycle', {
      body: JSON.stringify({
        parent: parent.id,
        fork: fork.id,
        messageBranch: branch.id,
        modelRequests: requests.length,
        forbiddenLaterCursor: 'INVALID_CURSOR',
        offlineReplay: true,
        canonicalHashPreserved: true,
        finalReferenceCollected: true
      }),
      contentType: 'application/json'
    })
  } finally {
    await testInfo.attach('web-evidence-debug', {
      body: JSON.stringify({
        evidence,
        sessions: await app.page
          .evaluate(async () => (await window.api.sessions.loadAll()).sessions)
          .catch(() => [])
      }),
      contentType: 'application/json'
    })
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
  }
})
