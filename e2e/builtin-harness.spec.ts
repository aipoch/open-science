import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { openSettingsPage } from './fixtures/settings-preferences'

const initialPrompt =
  'Use the Notebook REPL tool repl_execute to execute exactly eval("console.log(\'HARNESS_TOOL_OK\')"). Do not use any other tool. After successful execution, reply exactly HARNESS_TURN_OK.'

test('built-in harness executes approved host MCP and restores its session after restart', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  const requests: {
    messages: { role: string; content?: unknown }[]
    tools?: { function: { name: string } }[]
  }[] = []
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'harness-e2e' }] }))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as HarnessRequest & {
      stream?: boolean
    }
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
    const resumed = JSON.stringify(body.messages.at(-1)?.content).includes('HARNESS_RESUMED_OK')
    const tool = body.tools?.find((item: { function: { name: string } }) =>
      item.function.name.endsWith('repl_execute')
    )
    const call = !resumed && body.messages.at(-1)?.role !== 'tool'
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'host-tool-1',
              type: 'function',
              function: {
                name: tool?.function.name ?? 'missing_repl',
                arguments: JSON.stringify({ code: `eval("console.log('HARNESS_TOOL_OK')")` })
              }
            }
          ]
        }
      : { content: resumed ? 'HARNESS_RESUMED_OK' : 'HARNESS_TURN_OK' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } } })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const relay = process.env.OPEN_SCIENCE_E2E_HARNESS_RELAY_URL
  const model = process.env.OPEN_SCIENCE_E2E_HARNESS_MODEL ?? 'harness-e2e'
  try {
    let page = await app.completeOnboarding()
    await page.evaluate(
      async ({ baseUrl, model }) => {
        await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
        const settings = await window.api.settings.upsertProvider({
          type: 'custom',
          name: 'Harness acceptance',
          baseUrl,
          model,
          key: 'local-harness-fixture',
          apiEndpoints: ['chat-completions'],
          contextWindow: 200_000,
          maxOutputTokens: 4096
        })
        const provider = settings.providers.find((item) => item.name === 'Harness acceptance')!
        await window.api.settings.setActiveProvider({ id: provider.id, model })
        await window.api.settings.setDefaultPermissionProfile({ profile: 'ask' })
      },
      { baseUrl: relay ?? `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, model }
    )
    const settings = await openSettingsPage(page, 'Agent')
    const choice = settings.getByRole('radio', { name: 'Use Open-Science Agent', exact: true })
    await expect(choice).toBeVisible()
    await expect(choice).not.toHaveAttribute('aria-checked', 'true')
    await choice.click()
    const confirmation = page.getByRole('alertdialog', {
      name: 'Switch to Open-Science Agent?',
      exact: true
    })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Switch', exact: true }).click()
    await expect(choice).toHaveAttribute('aria-checked', 'true')
    await settings.getByRole('button', { name: 'Close settings' }).click()
    const projectId = await createProject(page, 'Built-in harness acceptance')
    await submitPromptViaUi(page, initialPrompt)
    const permission = page.getByTestId('permission-card')
    await expect(permission).toBeVisible({ timeout: 90_000 })
    await page.screenshot({ path: testInfo.outputPath('harness-permission.png'), fullPage: true })
    await expect(permission).toHaveAttribute(
      'aria-label',
      'Permission request: Review potentially destructive code'
    )
    await permission.getByTestId('allow-primary').click()
    await expect(page.getByText('HARNESS_TURN_OK', { exact: true })).toBeVisible({
      timeout: 90_000
    })
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    const before = (
      await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((session) => session.projectId === projectId)!
    expect(before.agentFrameworkId).toBe('open-science-agent')
    expect(before.providerSessionId).toEqual(expect.any(String))
    const runs = await app.readNotebookFixtureRuns(projectId, before.id)
    const executed = runs.filter(
      (run) => run.kernelKind === 'repl' && run.script.includes('HARNESS_TOOL_OK')
    )
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatchObject({
      status: 'completed',
      text: { stdout: expect.stringContaining('HARNESS_TOOL_OK') }
    })
    await page.screenshot({ path: testInfo.outputPath('harness-executed.png'), fullPage: true })
    page = await app.restart()
    await openProjectSession(page, 'Built-in harness acceptance', initialPrompt)
    await submitPromptViaUi(page, 'Reply exactly HARNESS_RESUMED_OK without calling tools.')
    await expect(page.getByText('HARNESS_RESUMED_OK', { exact: true })).toBeVisible({
      timeout: 90_000
    })
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    const after = (
      await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((session) => session.id === before.id)!
    expect(after.providerSessionId).toBe(before.providerSessionId)
    expect(
      (await app.readNotebookFixtureRuns(projectId, before.id)).filter((run) =>
        run.script.includes('HARNESS_TOOL_OK')
      )
    ).toHaveLength(1)
    if (!relay) expect(requests).toHaveLength(3)
    await page.screenshot({ path: testInfo.outputPath('harness-resumed.png'), fullPage: true })
    await testInfo.attach('harness-evidence', {
      body: JSON.stringify({
        realProvider: Boolean(relay),
        framework: after.agentFrameworkId,
        model,
        providerSessionPreserved: before.providerSessionId === after.providerSessionId,
        toolExecutions: executed.length,
        modelRequests: relay ? undefined : requests.length
      }),
      contentType: 'application/json'
    })
  } finally {
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
  }
})

type HarnessRequest = {
  model?: string
  messages: { role: string; content?: unknown; tool_calls?: unknown[] }[]
  tools?: { function: { name: string } }[]
}
type HarnessReply = string | { tool: string; args: Record<string, unknown> } | null

async function capabilityHost(
  app: import('./fixtures/electron-app').ElectronApp,
  reply: (body: HarnessRequest) => HarnessReply | Promise<HarnessReply>
): Promise<{
  page: import('@playwright/test').Page
  requests: HarnessRequest[]
  close(): Promise<void>
}> {
  const requests: HarnessRequest[] = []
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as HarnessRequest
    requests.push(body)
    const result = await reply(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (result === null) {
      response.write(': waiting\n\n')
      return
    }
    const call = typeof result !== 'string'
    const name = call
      ? body.tools?.find((t) => t.function.name.endsWith(`__${result.tool}`))?.function.name
      : undefined
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              type: 'function',
              function: { name: name ?? result.tool, arguments: JSON.stringify(result.args) }
            }
          ]
        }
      : { content: result.slice(Math.ceil(result.length / 2)) }
    // Real providers fragment replies; one-chunk fixtures hide missing ACP message identities.
    if (typeof result === 'string')
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: result.slice(0, Math.ceil(result.length / 2)) }, finish_reason: null }] })}\n\n`
      )
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const close = async (): Promise<void> => {
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
  }
  try {
    const page = await app.completeOnboarding()
    await page.evaluate(
      async (baseUrl) => {
        await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
        const settings = await window.api.settings.upsertProvider({
          type: 'custom',
          name: 'Harness capability fixture',
          baseUrl,
          model: 'harness-capabilities',
          key: 'fixture',
          apiEndpoints: ['chat-completions'],
          supportsImageInput: true,
          contextWindow: 200000,
          maxOutputTokens: 4096
        })
        const provider = settings.providers.find((p) => p.name === 'Harness capability fixture')!
        await window.api.settings.setActiveProvider({ id: provider.id, model: provider.model! })
        await window.api.settings.setDefaultPermissionProfile({ profile: 'ask' })
      },
      `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`
    )
    const settings = await openSettingsPage(page, 'Agent')
    await settings.getByRole('radio', { name: 'Use Open-Science Agent', exact: true }).click()
    await page
      .getByRole('alertdialog', { name: 'Switch to Open-Science Agent?', exact: true })
      .getByRole('button', { name: 'Switch', exact: true })
      .click()
    await expect(
      settings.getByRole('radio', { name: 'Use Open-Science Agent', exact: true })
    ).toHaveAttribute('aria-checked', 'true')
    await settings.getByRole('button', { name: 'Close settings' }).click()
    return { page, requests, close }
  } catch (error) {
    await close()
    throw error
  }
}

const lastUser = (body: HarnessRequest): string =>
  JSON.stringify(body.messages.findLast((m) => m.role === 'user')?.content)

const isChildRequest = (body: HarnessRequest): boolean =>
  body.messages.some(
    (message) =>
      message.role === 'system' &&
      JSON.stringify(message.content).includes('You are a Subagent executing a delegated Attempt')
  )

test('built-in harness asks the user and receives the selected answer', async ({
  app
}, testInfo) => {
  test.setTimeout(120000)
  let asked = false
  const host = await capabilityHost(app, (body) => {
    if (asked)
      return JSON.stringify(body.messages.at(-1)?.content).includes('Dataset Alpha')
        ? 'HARNESS_ANSWER_RECEIVED'
        : 'HARNESS_WAITING_FOR_ANSWER'
    asked = true
    return {
      tool: 'ask_user_question',
      args: {
        questions: [
          {
            question: 'Which fixture dataset?',
            kind: 'single-select',
            options: [
              { label: 'Dataset Alpha', description: 'First fixture' },
              { label: 'Dataset Beta', description: 'Second fixture' }
            ]
          }
        ]
      }
    }
  })
  try {
    await createProject(host.page, 'Harness question acceptance')
    await submitPromptViaUi(host.page, 'Ask which dataset to use.')
    await expect(host.page.getByText('Dataset Alpha', { exact: true }).first()).toBeVisible({
      timeout: 30000
    })
    host.page = await app.restart()
    await host.page
      .getByRole('button', {
        name: 'Open session Ask which dataset to use., waiting for your answer',
        exact: true
      })
      .click()
    await expect(host.page.getByText('Dataset Alpha', { exact: true }).first()).toBeVisible()
    await host.page.getByText('Dataset Alpha', { exact: true }).first().click()
    await expect(host.page.getByText('HARNESS_ANSWER_RECEIVED', { exact: true })).toHaveCount(0)
    await host.page.getByRole('button', { name: 'Finish', exact: true }).click()
    await expect(host.page.getByText('HARNESS_ANSWER_RECEIVED', { exact: true })).toBeVisible({
      timeout: 30000
    })
    expect(JSON.stringify(host.requests.slice(1))).toContain('Dataset Alpha')
    await host.page.screenshot({ path: testInfo.outputPath('ask-user.png') })
  } finally {
    await host.close()
  }
})

test('built-in harness creates a host plan and continues only after approval', async ({
  app
}, testInfo) => {
  test.setTimeout(120000)
  let planned = false
  let progress = 0
  const host = await capabilityHost(app, (body) => {
    if (lastUser(body).includes('UPDATE_PLAN_PROGRESS')) {
      if (progress < 2)
        return {
          tool: 'update_step_status',
          args: { title: 'Verify fixture', status: progress++ === 0 ? 'in_progress' : 'completed' }
        }
      return 'HARNESS_PLAN_COMPLETE'
    }
    if (planned) return 'HARNESS_PLAN_APPROVED'
    planned = true
    return {
      tool: 'generate_plan',
      args: {
        task_summary: 'Harness plan acceptance',
        phases: [
          {
            name: 'Verify',
            delegations: [
              {
                name: 'Local task',
                steps: [
                  {
                    title: 'Verify fixture',
                    description: 'Check the fixture and report the result.'
                  }
                ]
              }
            ]
          }
        ],
        desired_outputs: ['Verification result'],
        feasibility: { confidence: 'high', rationale: 'Local deterministic fixture' }
      }
    }
  })
  try {
    await createProject(host.page, 'Harness plan acceptance')
    await submitPromptViaUi(host.page, 'Generate a plan for the fixture and wait for approval.')
    const permission = host.page.getByTestId('permission-card')
    await expect(permission).toBeVisible()
    await permission.getByTestId('allow-primary').click()
    await expect(
      host.page.getByRole('button', { name: 'Approve', exact: true }).first()
    ).toBeVisible({ timeout: 30000 })
    await expect(host.page.getByText('HARNESS_PLAN_APPROVED', { exact: true })).toHaveCount(0)
    // Human review can outlast MCP's 60s idle timeout; host progress must keep it alive.
    await host.page.waitForTimeout(65_000)
    await expect(
      host.page.getByRole('button', { name: 'Approve', exact: true }).first()
    ).toBeVisible()
    await host.page.getByRole('button', { name: 'Approve', exact: true }).first().click()
    await expect(host.page.getByText('HARNESS_PLAN_APPROVED', { exact: true })).toBeVisible({
      timeout: 30000
    })
    expect(JSON.stringify(host.requests.slice(1))).toMatch(/approved/i)
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await submitPromptViaUi(host.page, 'UPDATE_PLAN_PROGRESS')
    await expect(host.page.getByText('HARNESS_PLAN_COMPLETE', { exact: true })).toBeVisible({
      timeout: 30000
    })
    expect(JSON.stringify(host.requests.at(-1)?.messages.at(-1)?.content)).toMatch(/completed/)
    await host.page.screenshot({ path: testInfo.outputPath('plan-approved.png') })
  } finally {
    await host.close()
  }
})

test('built-in harness rejects denied execution and can cancel then continue', async ({
  app
}, testInfo) => {
  test.setTimeout(120000)
  const host = await capabilityHost(app, (body) => {
    if (lastUser(body).includes('HOLD_STREAM')) return null
    if (lastUser(body).includes('AFTER_CANCEL')) return 'HARNESS_RECOVERED'
    if (body.messages.at(-1)?.role === 'tool') return 'HARNESS_DENIED'
    return { tool: 'repl_execute', args: { code: `eval("console.log('MUST_NOT_EXECUTE')")` } }
  })
  try {
    const projectId = await createProject(host.page, 'Harness denial and cancel')
    await submitPromptViaUi(host.page, 'Attempt the controlled fixture execution.')
    const card = host.page.getByTestId('permission-card')
    await expect(card).toBeVisible({ timeout: 30000 })
    await card.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect(host.page.getByText('HARNESS_DENIED', { exact: true })).toBeVisible({
      timeout: 30000
    })
    const session = (
      await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((s) => s.projectId === projectId)!
    expect(
      (await app.readNotebookFixtureRuns(projectId, session.id)).some(
        (run) => run.status === 'completed' && run.script.includes('MUST_NOT_EXECUTE')
      )
    ).toBe(false)
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await submitPromptViaUi(host.page, 'HOLD_STREAM')
    await expect
      .poll(() => host.requests.some((r) => lastUser(r).includes('HOLD_STREAM')))
      .toBe(true)
    await host.page.getByRole('button', { name: 'Cancel run', exact: true }).click()
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await submitPromptViaUi(host.page, 'AFTER_CANCEL')
    await expect(host.page.getByText('HARNESS_RECOVERED', { exact: true })).toBeVisible({
      timeout: 30000
    })
  } catch (error) {
    const details = host.page.getByText('Details', { exact: true })
    if (await details.isVisible()) await details.click()
    await testInfo.attach('denial-recovery-diagnostics', {
      body: await host.page.locator('body').innerText(),
      contentType: 'text/plain'
    })
    throw error
  } finally {
    await host.close()
  }
})

test('built-in harness isolates Side chat and drops it on application restart', async ({
  app
}, testInfo) => {
  test.setTimeout(120000)
  const host = await capabilityHost(app, (body) =>
    lastUser(body).includes('SIDE_CONTINUE')
      ? 'HARNESS_SIDE_NEW_MODEL'
      : lastUser(body).includes('SIDE_PROBE')
        ? 'HARNESS_SIDE_REPLY'
        : 'HARNESS_MAIN_REPLY'
  )
  try {
    const projectId = await createProject(host.page, 'Harness Side chat acceptance')
    await submitPromptViaUi(host.page, 'MAIN_PROBE')
    await expect(host.page.getByText('HARNESS_MAIN_REPLY', { exact: true })).toBeVisible()
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await host.page.getByTestId('branch-send-menu-trigger').click()
    await host.page.getByTestId('menu-side-chat').click()
    await host.page.getByPlaceholder('Follow up…').fill('SIDE_PROBE')
    await host.page.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
    await expect(host.page.getByText('HARNESS_SIDE_REPLY', { exact: true })).toBeVisible({
      timeout: 30000
    })
    await expect
      .poll(
        async () => (await host.page.evaluate(() => window.api.sideChat.list())).chats[0]?.running
      )
      .toBe(false)
    const parent = (
      await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((s) => s.projectId === projectId)!
    expect(JSON.stringify(parent.messages)).not.toContain('SIDE_PROBE')
    expect(JSON.stringify(host.requests.at(-1)?.messages)).toContain('MAIN_PROBE')
    await host.page.evaluate(async () => {
      const settings = await window.api.settings.getSettings()
      const original = settings.providers.find((p) => p.name === 'Harness capability fixture')!
      await window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Harness Side target',
        baseUrl: original.baseUrl,
        model: 'harness-side-v2',
        key: 'fixture',
        apiEndpoints: ['chat-completions'],
        contextWindow: 200000
      })
    })
    const sidePanel = host.page.getByRole('tabpanel', { name: 'Side chat', exact: true })
    await sidePanel.getByRole('button', { name: 'Select model', exact: true }).click()
    await host.page.getByRole('menuitem', { name: /^Model/ }).hover()
    await host.page
      .getByRole('group')
      .filter({ has: host.page.getByText('Harness Side target', { exact: true }) })
      .getByRole('menuitemradio', { name: 'harness-side-v2', exact: true })
      .focus()
    await host.page.keyboard.press('Enter')
    await sidePanel.getByPlaceholder('Follow up…').fill('SIDE_CONTINUE')
    await sidePanel.getByRole('button', { name: 'Send Side chat follow up', exact: true }).click()
    await expect(host.page.getByText('HARNESS_SIDE_NEW_MODEL', { exact: true })).toBeVisible({
      timeout: 30000
    })
    expect(host.requests.at(-1)?.model).toBe('harness-side-v2')
    expect(JSON.stringify(host.requests.at(-1)?.messages)).toContain('SIDE_PROBE')
    await expect
      .poll(
        async () => (await host.page.evaluate(() => window.api.sideChat.list())).chats[0]?.running
      )
      .toBe(false)
    await host.page.screenshot({ path: testInfo.outputPath('side-chat.png') })
    const page = await app.restart()
    expect((await page.evaluate(() => window.api.sideChat.list())).chats).toEqual([])
  } finally {
    await host.close()
  }
})

test('built-in harness carries host.viewImage results and uploaded images to the model', async ({
  app
}, testInfo) => {
  test.setTimeout(120000)
  const host = await capabilityHost(app, (body) => {
    const prompt = lastUser(body)
    if (prompt.includes('UPLOAD_IMAGE')) return 'HARNESS_UPLOAD_RECEIVED'
    if (prompt.includes('untrusted tool output')) return 'HARNESS_IMAGE_RECEIVED'
    if (body.messages.at(-1)?.role === 'tool')
      return prompt.includes('VIEW_IMAGE') ? 'HARNESS_IMAGE_RECEIVED' : 'HARNESS_IMAGE_WORKSPACE'
    return {
      tool: 'repl_execute',
      args: {
        code: prompt.includes('VIEW_IMAGE')
          ? 'await host.viewImage({ path: "harness-image.png" })'
          : 'console.log("IMAGE_WORKSPACE_READY")'
      }
    }
  })
  try {
    const projectId = await createProject(host.page, 'Harness image acceptance')
    await submitPromptViaUi(host.page, 'INITIALIZE_IMAGE_WORKSPACE')
    await expect(host.page.getByText('HARNESS_IMAGE_WORKSPACE', { exact: true })).toBeVisible({
      timeout: 30000
    })
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    const session = (
      await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((s) => s.projectId === projectId)!
    const runs = await app.readNotebookFixtureRuns(projectId, session.id)
    const workspace = runs.find((r) => r.script.includes('IMAGE_WORKSPACE_READY'))!.cwdBefore!
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { default: sharp } = await import('sharp')
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ff0000' }
    })
      .png()
      .toBuffer()
    await writeFile(join(workspace, 'harness-image.png'), png)
    await submitPromptViaUi(host.page, 'VIEW_IMAGE')
    await expect(host.page.getByText('HARNESS_IMAGE_RECEIVED', { exact: true })).toBeVisible({
      timeout: 30000
    })
    const view = host.requests.at(-1)!
    const imageParts = view.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((part) => part.type === 'image_url') : []
      )
    expect(imageParts).toHaveLength(1)
    expect(imageParts[0].image_url.url).toMatch(/^data:image\/(?:png|jpeg);base64,/)
    expect(
      await sharp(Buffer.from(imageParts[0].image_url.url.split(',')[1], 'base64')).metadata()
    ).toMatchObject({ width: 32, height: 32 })
    const imageRun = (await app.readNotebookFixtureRuns(projectId, session.id)).find((r) =>
      r.script.includes('host.viewImage(')
    )
    expect(imageRun?.status).toBe('completed')
    await host.page
      .locator('input[type="file"][multiple]')
      .setInputFiles({ name: 'uploaded-image.png', mimeType: 'image/png', buffer: png })
    await submitPromptViaUi(host.page, 'UPLOAD_IMAGE')
    await expect(host.page.getByText('HARNESS_UPLOAD_RECEIVED', { exact: true })).toBeVisible({
      timeout: 30000
    })
    expect(
      JSON.stringify(host.requests.at(-1)!.messages.filter((m) => m.role === 'user'))
    ).toContain('data:image/')
    await host.page.screenshot({ path: testInfo.outputPath('images.png') })
  } finally {
    await host.close()
  }
})

test('built-in harness delegates through the host and returns the child result', async ({
  app
}, testInfo) => {
  test.setTimeout(120000)
  let delegated = false
  const host = await capabilityHost(app, (body) => {
    if (
      body.messages.at(-1)?.role === 'user' &&
      JSON.stringify(body.messages.at(-1)?.content).includes('CHILD_ONLY_TASK')
    )
      return 'HARNESS_CHILD_RESULT'
    if (delegated) return 'HARNESS_DELEGATION_COMPLETE'
    delegated = true
    return {
      tool: 'repl_execute',
      args: {
        code: 'const result = await host.delegate({ task: "CHILD_ONLY_TASK", name: "Harness child" }, { wait: true }); console.log(JSON.stringify(result)); return result'
      }
    }
  })
  try {
    const projectId = await createProject(host.page, 'Harness delegation acceptance')
    await submitPromptViaUi(host.page, 'Delegate a focused task. PARENT_PRIVATE_MARKER')
    await expect(host.page.getByText('HARNESS_DELEGATION_COMPLETE', { exact: true })).toBeVisible({
      timeout: 60000
    })
    const sessions = (
      await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).filter((s) => s.projectId === projectId)
    const runs = await app.readNotebookFixtureRuns(projectId, sessions[0].id)
    expect(runs[0].status).toBe('completed')
    expect(JSON.stringify(runs[0].text)).toContain('HARNESS_CHILD_RESULT')
    const child = host.requests.find(
      (body) =>
        JSON.stringify(body.messages.at(-1)?.content).includes('CHILD_ONLY_TASK') &&
        body.messages.at(-1)?.role === 'user'
    )
    expect(child).toBeDefined()
    expect(JSON.stringify(child!.messages)).not.toContain('PARENT_PRIVATE_MARKER')
    await testInfo.attach('delegation', {
      body: JSON.stringify({ requests: host.requests.length, result: runs[0].text }),
      contentType: 'application/json'
    })
  } finally {
    await host.close()
  }
})

test('built-in harness rejects malformed tool arguments before host execution', async ({ app }) => {
  test.setTimeout(120000)
  const host = await capabilityHost(app, (body) =>
    body.messages.at(-1)?.role === 'tool'
      ? 'HARNESS_INVALID_ARGUMENT_HANDLED'
      : { tool: 'repl_execute', args: { code: 123 } }
  )
  try {
    const projectId = await createProject(host.page, 'Harness tool validation')
    await submitPromptViaUi(host.page, 'Probe malformed tool input.')
    await expect(
      host.page.getByText('HARNESS_INVALID_ARGUMENT_HANDLED', { exact: true })
    ).toBeVisible({ timeout: 30000 })
    const session = (
      await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((s) => s.projectId === projectId)!
    expect(await app.readNotebookFixtureRuns(projectId, session.id)).toEqual([])
    expect(JSON.stringify(host.requests.at(-1)?.messages.at(-1)?.content)).toMatch(/invalid/i)
    await expect(host.page.getByTestId('permission-card')).toHaveCount(0)
  } finally {
    await host.close()
  }
})

test('built-in harness reloads an edited Skill in the same conversation', async ({ app }) => {
  test.setTimeout(120000)
  const host = await capabilityHost(app, (body) => {
    if (body.messages.at(-1)?.role === 'tool') {
      const content = JSON.stringify(body.messages.at(-1)?.content)
      return content.includes('SKILL_REVISION_TWO')
        ? 'HARNESS_SKILL_TWO'
        : content.includes('SKILL_REVISION_ONE')
          ? 'HARNESS_SKILL_ONE'
          : 'HARNESS_SKILL_MISSING'
    }
    return { tool: 'load_skill', args: { skill: 'harness-reload' } }
  })
  try {
    const skill = await host.page.evaluate(async () => {
      const skills = await window.api.settings.createSkill({
        name: 'harness-reload',
        description: 'Reload acceptance fixture',
        body: 'SKILL_REVISION_ONE'
      })
      return skills.find((skill) => skill.name === 'harness-reload')!
    })
    await createProject(host.page, 'Harness Skill reload')
    await submitPromptViaUi(host.page, 'Load harness-reload and report its marker.')
    await expect(host.page.getByText('HARNESS_SKILL_ONE', { exact: true })).toBeVisible({
      timeout: 30000
    })
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await host.page.evaluate(async (id) => {
      await window.api.settings.updateSkill({
        id,
        description: 'Reload acceptance fixture',
        body: 'SKILL_REVISION_TWO'
      })
    }, skill.id)
    await submitPromptViaUi(host.page, 'Reload harness-reload after the edit.')
    await expect(host.page.getByText('HARNESS_SKILL_TWO', { exact: true })).toBeVisible({
      timeout: 30000
    })
    await expect(host.page.getByTestId('permission-card')).toBeHidden()
    expect(host.requests.at(-1)?.messages.at(-1)?.role).toBe('tool')
    expect(JSON.stringify(host.requests.at(-1)?.messages.at(-1)?.content)).not.toContain(
      'SKILL_REVISION_ONE'
    )
  } finally {
    await host.close()
  }
})

test('built-in harness switches Specialist by picker and approved agent handoff', async ({
  app
}) => {
  test.setTimeout(120000)
  let switched = false
  const host = await capabilityHost(app, (body) => {
    if (lastUser(body).includes('SWITCH_BACK') && !switched) {
      switched = true
      return { tool: 'repl_execute', args: { code: 'return await host.agents.switch(null)' } }
    }
    return JSON.stringify(body.messages).includes('SPECIALIST_PRIVATE_INSTRUCTIONS')
      ? 'HARNESS_SPECIALIST_ACTIVE'
      : 'HARNESS_MAIN_ACTIVE'
  })
  try {
    const specialist = await host.page.evaluate(() =>
      window.api.specialist.create({
        name: 'HARNESS_SPECIALIST',
        displayName: 'Harness Specialist',
        description: 'Harness switching fixture',
        systemPrompt: 'SPECIALIST_PRIVATE_INSTRUCTIONS',
        capabilityMode: 'selected',
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      })
    )
    await createProject(host.page, 'Harness Specialist acceptance')
    await submitPromptViaUi(host.page, 'INITIAL_MAIN')
    await expect(host.page.getByText('HARNESS_MAIN_ACTIVE', { exact: true })).toBeVisible()
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await host.page.getByRole('button', { name: /Agent controls:/ }).click()
    await host.page.getByTestId('specialist-submenu-trigger').press('ArrowRight')
    await host.page.getByTestId(`specialist-option-${specialist.id}`).click()
    await expect
      .poll(async () =>
        host.page.evaluate(async () => {
          const s = (await window.api.sessions.loadAll()).sessions[0]
          return { id: s.specialistId, pending: s.specialistBindingPending ?? null }
        })
      )
      .toEqual({ id: specialist.id, pending: null })
    await submitPromptViaUi(host.page, 'SPECIALIST_CHECK')
    await expect(host.page.getByText('HARNESS_SPECIALIST_ACTIVE', { exact: true })).toBeVisible()
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await submitPromptViaUi(host.page, 'SWITCH_BACK')
    const handoffApproval = host.page.getByRole('group', {
      name: 'Permission request: Switch to Main Agent?',
      exact: true
    })
    await expect(host.page.getByTestId('permission-card').or(handoffApproval).first()).toBeVisible()
    if (!(await handoffApproval.isVisible()))
      await host.page.getByTestId('permission-card').getByTestId('allow-primary').click()
    await handoffApproval.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect
      .poll(async () =>
        host.page.evaluate(async () => {
          const session = (await window.api.sessions.loadAll()).sessions[0]
          return {
            specialist: session.specialistId ?? null,
            pending: session.specialistBindingPending ?? null,
            status: session.status
          }
        })
      )
      .toEqual({ specialist: null, pending: null, status: 'idle' })
    expect(
      JSON.stringify(host.requests.at(-1)?.messages.filter((message) => message.role === 'system'))
    ).not.toContain('SPECIALIST_PRIVATE_INSTRUCTIONS')
  } finally {
    await host.close()
  }
})

test('built-in harness Reviewer reads scoped evidence and submits findings', async ({ app }) => {
  test.setTimeout(120000)
  const host = await capabilityHost(app, (body) => {
    if (body.tools?.some((tool) => tool.function.name.endsWith('__read_turn'))) {
      const calls = JSON.stringify(body.messages)
      if (!calls.includes('"name":"') || !calls.includes('__read_turn'))
        return { tool: 'read_turn', args: {} }
      if (!calls.includes('__submit_findings'))
        return {
          tool: 'submit_findings',
          args: {
            checks: [
              {
                status: 'pass',
                claim: 'Fixture answer is present.',
                evidence: 'Read the frozen turn through read_turn.'
              }
            ]
          }
        }
      return 'HARNESS_REVIEW_COMPLETE'
    }
    return 'HARNESS_REVIEW_SUBJECT'
  })
  try {
    await createProject(host.page, 'Harness Reviewer acceptance')
    await host.page.getByTestId('composer-controls-trigger').click()
    await host.page.getByRole('menuitem', { name: 'Auto-review', exact: true }).click()
    await host.page.keyboard.press('Escape')
    await submitPromptViaUi(host.page, 'Provide a short answer for review.')
    await expect
      .poll(
        async () =>
          host.page.evaluate(async () => {
            const session = (await window.api.sessions.loadAll()).sessions[0]
            return session
              ? await window.api.reviewer.getForSession({
                  projectId: session.projectId,
                  appSessionId: session.id
                })
              : []
          }),
        { timeout: 60000 }
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lifecycle: 'complete',
            outcome: 'pass',
            checks: expect.arrayContaining([expect.objectContaining({ status: 'pass' })])
          })
        ])
      )
    expect(
      host.requests.some((body) => JSON.stringify(body.messages).includes('__submit_findings'))
    ).toBe(true)
  } finally {
    await host.close()
  }
})

test('built-in harness invokes a configured Connector through Notebook', async ({ app }) => {
  test.setTimeout(120000)
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const { z } = await import('zod')
  const invocations: unknown[] = []
  const connector = createServer(async (request, response) => {
    const server = new McpServer({ name: 'harness-connector', version: '1' })
    server.registerTool(
      'lookup',
      { inputSchema: { record: z.string() }, annotations: { readOnlyHint: true } },
      async (args) => {
        invocations.push(args)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ record: args.record, value: 'CONNECTOR_RESULT' })
            }
          ]
        }
      }
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  })
  await new Promise<void>((resolve) => connector.listen(0, '127.0.0.1', resolve))
  const host = await capabilityHost(app, (body) =>
    body.messages.at(-1)?.role === 'tool'
      ? JSON.stringify(body.messages.at(-1)?.content).includes('CONNECTOR_RESULT')
        ? 'HARNESS_CONNECTOR_OK'
        : 'HARNESS_CONNECTOR_FAILED'
      : {
          tool: 'repl_execute',
          args: {
            code: 'return await host.mcp("harness-connector", "lookup", { record: "fixture-42" })'
          }
        }
  )
  try {
    await host.page.evaluate(
      async (url) => {
        await window.api.settings.addCustomServer({
          id: 'harness-connector',
          name: 'harness-connector',
          displayName: 'Harness Connector',
          transport: 'streamable_http',
          url
        })
        await window.api.settings.setCustomServerEnabled({ id: 'harness-connector', enabled: true })
        await window.api.settings.setConnectorAutoAllow({
          id: 'harness-connector',
          autoAllow: true
        })
      },
      `http://127.0.0.1:${(connector.address() as AddressInfo).port}/mcp`
    )
    await createProject(host.page, 'Harness Connector acceptance')
    await submitPromptViaUi(host.page, 'Query the configured fixture Connector.')
    await expect(host.page.getByText('HARNESS_CONNECTOR_OK', { exact: true })).toBeVisible({
      timeout: 30000
    })
    expect(invocations).toEqual([{ record: 'fixture-42' }])
  } finally {
    await host.close()
    connector.closeAllConnections()
    await new Promise<void>((resolve) => connector.close(() => resolve()))
  }
})

test('built-in harness completes parallel delegated children with separate evidence', async ({
  app
}) => {
  test.setTimeout(120000)
  let started = false
  const host = await capabilityHost(app, (body) => {
    if (lastUser(body).includes('PARALLEL_CHILD_A')) return 'PARALLEL_RESULT_A'
    if (lastUser(body).includes('PARALLEL_CHILD_B')) return 'PARALLEL_RESULT_B'
    if (started) return 'PARALLEL_PARENT_DONE'
    started = true
    return {
      tool: 'repl_execute',
      args: {
        code: 'const results = await host.delegate([{ task: "PARALLEL_CHILD_A", name: "Child A" }, { task: "PARALLEL_CHILD_B", name: "Child B" }], { wait: true }); console.log(JSON.stringify(results)); return results'
      }
    }
  })
  try {
    const projectId = await createProject(host.page, 'Harness parallel children')
    await submitPromptViaUi(host.page, 'Run the independent child tasks. PRIVATE_PARENT')
    await expect(host.page.getByText('PARALLEL_PARENT_DONE', { exact: true })).toBeVisible({
      timeout: 60000
    })
    const session = (
      await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((s) => s.projectId === projectId)!
    const records = session.runtimeContext?.delegatedWork?.records ?? []
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.attempts.at(-1)?.status === 'completed')).toBe(true)
    const runs = await app.readNotebookFixtureRuns(projectId, session.id)
    expect(JSON.stringify(runs.map((run) => run.text))).toContain('PARALLEL_RESULT_A')
    expect(JSON.stringify(runs.map((run) => run.text))).toContain('PARALLEL_RESULT_B')
    for (const request of host.requests.filter((body) =>
      /PARALLEL_CHILD_[AB]/.test(lastUser(body))
    ))
      expect(JSON.stringify(request.messages)).not.toContain('PRIVATE_PARENT')
  } finally {
    await host.close()
  }
})

for (const interaction of ['permission', 'question'] as const) {
  test(`built-in harness routes delegated ${interaction} through the host`, async ({ app }) => {
    test.setTimeout(120000)
    let delegated = false,
      childCalled = false
    const host = await capabilityHost(app, (body) => {
      if (isChildRequest(body)) {
        if (childCalled) return 'INTERACTIVE_CHILD_DONE'
        childCalled = true
        return interaction === 'permission'
          ? {
              tool: 'repl_execute',
              args: { code: 'eval("console.log(\'CHILD_PERMISSION_EFFECT\')")' }
            }
          : {
              tool: 'ask_user_question',
              args: {
                questions: [
                  {
                    question: 'Choose child evidence scope',
                    kind: 'single-select',
                    options: [
                      { label: 'Focused', description: 'Small scope' },
                      { label: 'Broad', description: 'All scope' }
                    ]
                  }
                ]
              }
            }
      }
      if (delegated) return 'INTERACTIVE_PARENT_DONE'
      delegated = true
      return {
        tool: 'repl_execute',
        args: {
          code: 'const result = await host.delegate({ task: "INTERACTIVE_CHILD_TASK", name: "Interactive child" }, { wait: true }); console.log(JSON.stringify(result)); return result'
        }
      }
    })
    try {
      const projectId = await createProject(host.page, `Harness delegated ${interaction}`)
      await submitPromptViaUi(host.page, 'Delegate an interactive fixture task.')
      if (interaction === 'question') {
        const card = host.page.getByTestId('delegated-question-card')
        await expect(card).toContainText('Choose child evidence scope', { timeout: 60000 })
        // The asking Attempt can complete before the user answers; it is not the continuation.
        await expect
          .poll(() =>
            host.page.evaluate(async (projectId) => {
              const session = (await window.api.sessions.loadAll()).sessions.find(
                (s) => s.projectId === projectId
              )!
              const work = session.runtimeContext?.delegatedWork
              const question = work?.questionRequests?.find((q) => q.status === 'pending')
              return work?.records
                .find((r) => r.agentFrameId === question?.sourceFrameId)
                ?.attempts.find((a) => a.id === question?.sourceAttemptId)?.status
            }, projectId)
          )
          .toBe('completed')
        await card.getByRole('button', { name: 'Focused', exact: true }).click()
        await card.getByRole('button', { name: 'Finish', exact: true }).click()
      } else {
        const card = host.page.getByRole('group', {
          name: 'Permission request: Review potentially destructive code',
          exact: true
        })
        await expect(card).toBeVisible({ timeout: 60000 })
        await expect(card).toContainText('CHILD_PERMISSION_EFFECT')
        expect(childCalled).toBe(true)
        expect(
          host.requests.some((body) =>
            body.messages.some(
              (message) =>
                message.role === 'tool' &&
                JSON.stringify(message.content).includes('CHILD_PERMISSION_EFFECT')
            )
          )
        ).toBe(false)
        await card.getByRole('button', { name: /^Allow/ }).click()
      }
      await expect(host.page.getByText('INTERACTIVE_PARENT_DONE', { exact: true })).toBeVisible({
        timeout: 60000
      })
      await expect
        .poll(async () =>
          host.page.evaluate(
            async ({ projectId, interaction }) => {
              const session = (await window.api.sessions.loadAll()).sessions.find(
                (s) => s.projectId === projectId
              )!
              const work = session.runtimeContext?.delegatedWork
              if (interaction === 'question') {
                const question = work?.questionRequests?.find((q) =>
                  q.questions.some((item) => item.question === 'Choose child evidence scope')
                )
                if (
                  question?.status !== 'confirmed' ||
                  !question.continuationAttemptId ||
                  question.continuationAttemptId === question.sourceAttemptId ||
                  !JSON.stringify(question.answers).includes('Focused')
                )
                  return 'awaiting-answer-continuation'
                return work?.records
                  .find((r) => r.agentFrameId === question.sourceFrameId)
                  ?.attempts.find((a) => a.id === question.continuationAttemptId)?.status
              }
              return work?.records[0].attempts.at(-1)?.status
            },
            { projectId, interaction }
          )
        )
        .toBe('completed')
      expect(
        host.requests.some(
          (body) =>
            isChildRequest(body) &&
            body.messages.some(
              (message) =>
                (message.role === 'tool' ||
                  (interaction === 'question' && message.role === 'user')) &&
                JSON.stringify(message.content).includes(
                  interaction === 'question' ? 'Focused' : 'CHILD_PERMISSION_EFFECT'
                )
            )
        ),
        JSON.stringify(
          host.requests.map((body) => ({
            child: isChildRequest(body),
            messages: body.messages
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: m.role, content: JSON.stringify(m.content).slice(-2000) }))
          }))
        )
      ).toBe(true)
    } finally {
      await host.close()
    }
  })
}

test('built-in harness stops a detached child and retains cancellation after restart', async ({
  app
}) => {
  test.setTimeout(120000)
  let delegated = false
  const host = await capabilityHost(app, (body) => {
    if (lastUser(body).includes('DETACHED_CHILD_HOLD')) return null
    if (delegated) return 'DETACHED_PARENT_IDLE'
    delegated = true
    return {
      tool: 'repl_execute',
      args: {
        code: 'return await host.delegate({ task: "DETACHED_CHILD_HOLD", name: "Detached child" }, { wait: false })'
      }
    }
  })
  try {
    const projectId = await createProject(host.page, 'Harness detached cancellation')
    await submitPromptViaUi(host.page, 'Start a detached fixture task.')
    await expect(host.page.getByText('DETACHED_PARENT_IDLE', { exact: true })).toBeVisible({
      timeout: 60000
    })
    await expect
      .poll(() => host.requests.some((body) => lastUser(body).includes('DETACHED_CHILD_HOLD')))
      .toBe(true)
    const ownedDirectory = await host.page.evaluate(async (projectId) => {
      const session = (await window.api.sessions.loadAll()).sessions.find(
        (s) => s.projectId === projectId
      )!
      return { root: (await window.api.storage.getInfo()).dataRoot, sessionId: session.id }
    }, projectId)
    const receiptDirectory = join(
      ownedDirectory.root,
      'delegation-process-ownership',
      projectId,
      ownedDirectory.sessionId
    )
    const ownedProcesses = async (): Promise<number> =>
      (
        await readdir(receiptDirectory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return []
        })
      ).filter((name) => name.endsWith('.json')).length
    await expect.poll(ownedProcesses).toBe(1)
    await host.page.getByRole('button', { name: 'Stop subagents', exact: true }).click()
    const state = async (): Promise<string | undefined> =>
      host.page.evaluate(async (projectId) => {
        const session = (await window.api.sessions.loadAll()).sessions.find(
          (s) => s.projectId === projectId
        )!
        return session.runtimeContext?.delegatedWork?.records[0].attempts.at(-1)?.status
      }, projectId)
    await expect.poll(state).toBe('cancelled')
    await expect.poll(ownedProcesses).toBe(0)
    host.page = await app.restart()
    await expect.poll(state).toBe('cancelled')
    await expect.poll(ownedProcesses).toBe(0)
  } finally {
    await host.close()
  }
})

test('built-in harness recovers a crashed model turn without repeating its completed tool', async ({
  app
}) => {
  test.setTimeout(180000)
  let recovering = false
  const host = await capabilityHost(app, (body) => {
    if (recovering) return 'CRASH_RECOVERY_COMPLETE'
    if (body.messages.at(-1)?.role === 'tool') return null
    return { tool: 'repl_execute', args: { code: 'console.log("CRASH_EFFECT_ONCE")' } }
  })
  try {
    const projectId = await createProject(host.page, 'Harness crash recovery')
    const prompt = 'Run one fixture operation and keep its result.'
    await submitPromptViaUi(host.page, prompt)
    // Locator assertions drive the consent handler; polling the HTTP log does not.
    await expect(host.page.getByRole('button', { name: /Completed a Notebook run/ })).toBeVisible()
    await expect
      .poll(() => host.requests.some((body) => body.messages.at(-1)?.role === 'tool'))
      .toBe(true)
    const session = (
      await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((s) => s.projectId === projectId)!
    host.page = await app.restartAfterCrash({ force: true })
    recovering = true
    await openProjectSession(host.page, 'Harness crash recovery', prompt)
    await host.page.getByRole('button', { name: 'Resume session', exact: true }).click()
    await expect(host.page.getByText('CRASH_RECOVERY_COMPLETE', { exact: true })).toBeVisible({
      timeout: 60000
    })
    expect(
      (await app.readNotebookFixtureRuns(projectId, session.id)).filter((run) =>
        run.script.includes('CRASH_EFFECT_ONCE')
      )
    ).toHaveLength(1)
    expect(JSON.stringify(host.requests.at(-1)?.messages)).toContain('CRASH_EFFECT_ONCE')
  } finally {
    await host.close()
  }
})

test('built-in harness delivers child messages and explicitly continues a completed child', async ({
  app
}) => {
  test.setTimeout(120000)
  let delegated = false,
    childSent = false,
    downwardSent = false
  const host = await capabilityHost(app, (body) => {
    const child = isChildRequest(body)
    if (child) {
      if (lastUser(body).includes('DOWNWARD_FIXTURE')) return 'CHILD_CONTINUATION_DONE'
      if (childSent) return 'CHILD_INITIAL_DONE'
      childSent = true
      return {
        tool: 'repl_execute',
        args: {
          code: 'const sent = await host.sendFrameMessage("parent", "UPWARD_FIXTURE", { kind: "question", requestId: "harness-upward-fixture" }); console.log(JSON.stringify(await host.messageReceipt(sent.messageId, { timeoutSeconds: 0 }))); return sent'
        }
      }
    }
    if (lastUser(body).includes('SEND_DOWNWARD_FIXTURE') && !downwardSent) {
      downwardSent = true
      return {
        tool: 'repl_execute',
        args: {
          code: 'const child = (await host.children()).find(child => child.name === "Messaging child"); if (!child) throw new Error("Child missing"); const sent = await host.sendFrameMessage(child.frameId, "DOWNWARD_FIXTURE", { requestId: "harness-downward-fixture" }); const result = await host.collect([{ frameId: sent.targetFrameId, attemptId: sent.continuationAttemptId }], { timeoutSeconds: 30 }); console.log(JSON.stringify(result)); return result'
        }
      }
    }
    if (delegated) return downwardSent ? 'MESSAGING_PARENT_FINISHED' : 'MESSAGING_PARENT_READY'
    delegated = true
    return {
      tool: 'repl_execute',
      args: {
        code: 'return await host.delegate({ task: "MESSAGE_CHILD_TASK", name: "Messaging child" }, { wait: true })'
      }
    }
  })
  try {
    const projectId = await createProject(host.page, 'Harness child messaging')
    await submitPromptViaUi(host.page, 'Delegate the messaging fixture task.')
    await expect(
      host.page.getByText('MESSAGING_PARENT_READY', { exact: true }).first()
    ).toBeVisible({ timeout: 60000 })
    const attempts = async (): Promise<string[] | undefined> =>
      host.page.evaluate(async (projectId) => {
        const session = (await window.api.sessions.loadAll()).sessions.find(
          (s) => s.projectId === projectId
        )!
        return session?.runtimeContext?.delegatedWork?.records[0]?.attempts.map(
          (attempt) => attempt.status
        )
      }, projectId)
    await expect.poll(attempts, { timeout: 60000 }).toEqual(['completed'])
    await expect
      .poll(
        () =>
          host.requests.some(
            (body) =>
              !isChildRequest(body) &&
              body.messages.some(
                (message) =>
                  ['user', 'tool'].includes(message.role) &&
                  JSON.stringify(message.content).includes('UPWARD_FIXTURE')
              )
          ),
        { timeout: 30000 }
      )
      .toBe(true)
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await submitPromptViaUi(
      host.page,
      'SEND_DOWNWARD_FIXTURE: explicitly continue the completed child.'
    )
    await expect(host.page.getByText('MESSAGING_PARENT_FINISHED', { exact: true })).toBeVisible({
      timeout: 60000
    })
    await expect.poll(attempts).toEqual(['completed', 'completed'])
    expect(
      host.requests.some((body) =>
        body.messages.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('CHILD_CONTINUATION_DONE')
        )
      )
    ).toBe(true)
  } finally {
    await host.close()
  }
})

test('built-in harness reaps a crashed running child before explicit continuation', async ({
  app
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'Exercises native macOS process birth identity.')
  test.setTimeout(180000)
  let recovering = false,
    delegated = false,
    continued = false
  const host = await capabilityHost(app, (body) => {
    if (isChildRequest(body)) return recovering ? 'COLD_CHILD_COMPLETE' : null
    if (recovering) {
      if (continued) return 'COLD_PARENT_COMPLETE'
      continued = true
      return {
        tool: 'repl_execute',
        args: {
          code: 'const child = (await host.children()).find(child => child.name === "Cold child"); if (!child || child.status !== "cancelled") throw new Error("Old child was not cancelled"); const sent = await host.sendFrameMessage(child.frameId, "Continue explicitly after crash; preserve prior results.", { requestId: "harness-cold-continuation" }); const result = await host.collect([{ frameId: sent.targetFrameId, attemptId: sent.continuationAttemptId }], { timeoutSeconds: 30 }); console.log(JSON.stringify(result)); return result'
        }
      }
    }
    if (delegated) return null
    delegated = true
    return {
      tool: 'repl_execute',
      args: {
        code: 'return await host.delegate({ task: "COLD_CHILD_HOLD", name: "Cold child" }, { wait: false })'
      }
    }
  })
  try {
    const projectId = await createProject(host.page, 'Harness running child crash')
    const prompt = 'Start the child and keep the task open for crash recovery.'
    await submitPromptViaUi(host.page, prompt)
    await expect(
      host.page.getByRole('button', { name: 'Cold child, running', exact: true })
    ).toBeVisible()
    await expect.poll(() => host.requests.some(isChildRequest)).toBe(true)
    const { session, dataRoot } = await host.page.evaluate(
      async (projectId) => ({
        session: (await window.api.sessions.loadAll()).sessions.find(
          (s) => s.projectId === projectId
        )!,
        dataRoot: (await window.api.storage.getInfo()).dataRoot
      }),
      projectId
    )
    const root = join(dataRoot, 'delegation-process-ownership', projectId, session.id)
    const files = await readdir(root)
    const filename = files.find((name) => name.endsWith('.json'))!
    expect(filename).toBeTruthy()
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(root, filename), 'utf8')).ownership?.leader?.birthToken
      )
      .toMatch(/^darwin-proc-uniqueid:/)
    const original = session.runtimeContext!.delegatedWork!.records[0].attempts[0].id
    await expect
      .poll(() =>
        host.requests.some((body) => !isChildRequest(body) && body.messages.at(-1)?.role === 'tool')
      )
      .toBe(true)
    host.page = await app.restartAfterCrash({ force: true })
    recovering = true
    await openProjectSession(host.page, 'Harness running child crash', prompt)
    await host.page.getByRole('button', { name: 'Resume session', exact: true }).click()
    await expect(host.page.getByText('COLD_PARENT_COMPLETE', { exact: true })).toBeVisible({
      timeout: 90000
    })
    const attempts = await host.page.evaluate(
      async (id) =>
        (await window.api.sessions.loadAll()).sessions.find((s) => s.id === id)?.runtimeContext
          ?.delegatedWork?.records[0].attempts,
      session.id
    )
    expect(attempts).toHaveLength(2)
    expect(attempts![0]).toMatchObject({ id: original, status: 'cancelled' })
    expect(attempts![1]).toMatchObject({ status: 'completed' })
    expect(attempts![1].id).not.toBe(original)
    await expect
      .poll(
        async () =>
          (
            await readdir(root).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
              return []
            })
          ).filter((name) => name.endsWith('.json')).length
      )
      .toBe(0)
    expect(
      host.requests.some(
        (body) =>
          !isChildRequest(body) &&
          body.messages.some(
            (message) =>
              message.role === 'tool' &&
              JSON.stringify(message.content).includes('COLD_CHILD_COMPLETE')
          )
      )
    ).toBe(true)
    await testInfo.attach('cold-child-attempts', {
      body: JSON.stringify(attempts),
      contentType: 'application/json'
    })
  } finally {
    await host.close()
  }
})

test('built-in harness permanently removes owned history and receipts after Session deletion', async ({
  app
}) => {
  const host = await capabilityHost(app, (body) =>
    body.messages.at(-1)?.role === 'tool'
      ? 'DELETE_READY'
      : { tool: 'repl_execute', args: { code: 'console.log("DELETE_RECEIPT")' } }
  )
  try {
    const projectId = await createProject(host.page, 'Harness permanent deletion')
    const prompt = 'Create one result for deletion acceptance.'
    await submitPromptViaUi(host.page, prompt)
    await expect(host.page.getByText('DELETE_READY', { exact: true })).toBeVisible()
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    const identity = await host.page.evaluate(
      async (projectId) => ({
        session: (await window.api.sessions.loadAll()).sessions.find(
          (s) => s.projectId === projectId
        )!,
        dataRoot: (await window.api.storage.getInfo()).dataRoot
      }),
      projectId
    )
    const storage = join(dirname((await app.captureBrandState()).profile), 'storage')
    const bindings = join(storage, 'open-science-agent', 'sessions')
    const owned: string[] = []
    for (const name of await readdir(bindings)) {
      if (!name.endsWith('.json')) continue
      const binding = JSON.parse(await readFile(join(bindings, name), 'utf8'))
      if (binding.owner?.sessionId === identity.session.id) {
        expect(binding.owner.projectId).toBe(projectId)
        owned.push(name.slice(0, -5))
      }
    }
    expect(owned.length).toBeGreaterThan(0)
    const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
    const receipt = join(
      identity.dataRoot,
      'open-science-agent',
      'tool-receipts',
      hash(JSON.stringify([projectId, identity.session.id, 'notebook']))
    )
    expect((await readdir(receipt)).length).toBeGreaterThan(0)
    await host.page.getByRole('button', { name: `Open actions for ${prompt}`, exact: true }).click()
    await host.page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await host.page
      .getByRole('alertdialog', { name: 'Delete Session?' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await expect
      .poll(async () =>
        (await readdir(bindings)).filter((name) => owned.some((id) => name === `${id}.json`))
      )
      .toEqual([])
    const checkpoints = await readdir(join(bindings, 'checkpoints'))
    for (const id of owned)
      expect(checkpoints.filter((name) => name.startsWith(hash(id)))).toEqual([
        `${hash(id)}.jsonl.deleted`
      ])
    expect(await readdir(receipt)).toEqual(['deleted'])
    host.page = await app.restart()
    expect(
      (await host.page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)).some(
        (s) => s.id === identity.session.id
      )
    ).toBe(false)
    expect(await readdir(receipt)).toEqual(['deleted'])
  } finally {
    await host.close()
  }
})

for (const protocol of ['messages', 'responses'] as const) {
  test(`built-in harness uses native ${protocol} through the real helper and approved MCP`, async ({
    app
  }) => {
    test.setTimeout(120_000)
    const requests: Record<string, unknown>[] = []
    const gateway = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'native-e2e' }] }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      requests.push(body)
      const tool = (body.tools as { name: string }[]).find((t) => t.name.endsWith('repl_execute'))!
      const first = requests.length === 1
      const events =
        protocol === 'messages'
          ? [
              ...(first
                ? [
                    {
                      type: 'content_block_start',
                      content_block: {
                        type: 'tool_use',
                        id: 'native_call',
                        name: tool.name,
                        input: {}
                      }
                    },
                    {
                      type: 'content_block_delta',
                      delta: {
                        type: 'input_json_delta',
                        partial_json: JSON.stringify({
                          code: `eval("console.log('HARNESS_TOOL_OK')")`
                        })
                      }
                    },
                    { type: 'content_block_stop' }
                  ]
                : [
                    {
                      type: 'content_block_delta',
                      delta: { type: 'text_delta', text: 'HARNESS_NATIVE_DONE' }
                    }
                  ]),
              {
                type: 'message_delta',
                delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
                usage: { output_tokens: 3 }
              },
              { type: 'message_stop' }
            ]
          : [
              ...(first
                ? [
                    {
                      type: 'response.output_item.done',
                      item: {
                        type: 'function_call',
                        call_id: 'native_call',
                        name: tool.name,
                        arguments: JSON.stringify({
                          code: `eval("console.log('HARNESS_TOOL_OK')")`
                        })
                      }
                    }
                  ]
                : [{ type: 'response.output_text.delta', delta: 'HARNESS_NATIVE_DONE' }]),
              {
                type: 'response.completed',
                response: { usage: { input_tokens: 10, output_tokens: 3 } }
              }
            ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    try {
      const page = await app.completeOnboarding()
      await page.evaluate(
        async ({ baseUrl, protocol }) => {
          await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          const settings = await window.api.settings.upsertProvider({
            type: 'custom',
            name: 'Harness native fixture',
            baseUrl,
            model: 'native-e2e',
            key: 'local',
            apiEndpoints: [protocol],
            contextWindow: 200000,
            maxOutputTokens: 4096
          })
          const provider = settings.providers.find((p) => p.name === 'Harness native fixture')!
          await window.api.settings.setActiveProvider({ id: provider.id, model: 'native-e2e' })
          await window.api.settings.setDefaultPermissionProfile({ profile: 'ask' })
        },
        { baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, protocol }
      )
      const settings = await openSettingsPage(page, 'Agent')
      await settings.getByRole('radio', { name: 'Use Open-Science Agent', exact: true }).click()
      await page
        .getByRole('alertdialog', { name: 'Switch to Open-Science Agent?', exact: true })
        .getByRole('button', { name: 'Switch', exact: true })
        .click()
      await settings.getByRole('button', { name: 'Close settings' }).click()
      await page.addLocatorHandler(
        page.getByRole('group', {
          name: 'Permission request: Review potentially destructive code',
          exact: true
        }),
        async (card) => {
          await card.getByTestId('allow-primary').click()
        }
      )
      await createProject(page, `Native ${protocol} acceptance`)
      await submitPromptViaUi(page, initialPrompt)
      await expect(page.getByText('HARNESS_NATIVE_DONE', { exact: true })).toBeVisible({
        timeout: 60000
      })
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1][protocol === 'messages' ? 'messages' : 'input'])).toContain(
        'HARNESS_TOOL_OK'
      )
      expect(requests.every((r) => r.stream === true)).toBe(true)
    } finally {
      gateway.closeAllConnections()
      await new Promise<void>((resolve) => gateway.close(() => resolve()))
    }
  })
}

test('built-in harness retains warm turns and releases its idle process', async ({
  app
}, testInfo) => {
  test.setTimeout(360_000)
  const host = await capabilityHost(app, (body) => {
    const match = lastUser(body).match(/IDLE_REPLY_\d/)
    return match?.[0] ?? 'IDLE_REPLY_UNKNOWN'
  })
  await app.beginResourceProfile({ sampleIntervalMs: 1000 })
  host.page = app.page
  try {
    await createProject(host.page, 'Harness idle lifecycle')
    const initializedCount = async (): Promise<number> => {
      const path = await app.captureMainLog('idle-lifecycle.log')
      const initialized = new Set<string>()
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        if (!line.startsWith('{')) continue
        const record = JSON.parse(line)
        if (record.scope === 'acp' && record.msg === 'agent initialized')
          initialized.add(`${record.runId}:${record.t}`)
      }
      return initialized.size
    }
    const run = async (index: number, phase: string): Promise<void> => {
      await app.markResourceProfilePhase(phase)
      const started = performance.now()
      await submitPromptViaUi(host.page, `Reply exactly IDLE_REPLY_${index} without tools.`)
      await expect(host.page.getByText(`IDLE_REPLY_${index}`, { exact: true })).toBeVisible({
        timeout: 90_000
      })
      await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
      app.recordResourceTiming(phase, performance.now() - started)
      await app.sampleResourceProfileNow()
    }
    await run(1, 'cold')
    const cold = await initializedCount()
    expect(cold).toBeGreaterThan(0)
    await run(2, 'warm')
    expect(await initializedCount()).toBe(cold)
    await app.markResourceProfilePhase('idle-expiry')
    await host.page.waitForTimeout(65_000)
    await app.sampleResourceProfileNow()
    await run(3, 'after-expiry')
    expect(await initializedCount()).toBe(cold + 1)
    expect(host.requests).toHaveLength(3)
    const usage = await host.page.evaluate(async () => {
      const { sessions } = await window.api.sessions.loadAll()
      return sessions.flatMap((session) =>
        session.messages
          .filter(
            (message) => message.turnUsage || message.modelCallUsage || message.turnUsageUnavailable
          )
          .map((message) => ({
            turnUsage: message.turnUsage,
            modelCallUsage: message.modelCallUsage,
            unavailable: message.turnUsageUnavailable
          }))
      )
    })
    await testInfo.attach('idle-usage', {
      body: JSON.stringify({ live: false, usage }),
      contentType: 'application/json'
    })
    await app.markResourceProfilePhase('final-idle-expiry')
    await host.page.waitForTimeout(65_000)
    await app.sampleResourceProfileNow()
  } finally {
    const profile = await app.finishResourceProfile()
    await testInfo.attach('idle-resource-profile', {
      body: JSON.stringify(profile),
      contentType: 'application/json'
    })
    await host.close()
  }
})

test('built-in harness keeps a shared process while another primary Session is busy', async ({
  app
}) => {
  const firstReply = Promise.withResolvers<HarnessReply>()
  const host = await capabilityHost(app, (body) =>
    lastUser(body).includes('PRIMARY_BUSY') ? firstReply.promise : 'PRIMARY_SECOND_DONE'
  )
  try {
    await createProject(host.page, 'Harness busy primary')
    await submitPromptViaUi(host.page, 'Reply PRIMARY_BUSY_DONE when ready. PRIMARY_BUSY')
    await expect.poll(() => host.requests.length).toBe(1)
    const second = await app.openAdditionalRenderer()
    await createProject(second, 'Harness concurrent primary')
    await submitPromptViaUi(second, 'Reply PRIMARY_SECOND_DONE without tools.')
    await expect(second.getByText('PRIMARY_SECOND_DONE', { exact: true })).toBeVisible()
    await expect(second.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await expect(host.page.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible()
    firstReply.resolve('PRIMARY_BUSY_DONE')
    await expect(host.page.getByText('PRIMARY_BUSY_DONE', { exact: true })).toBeVisible()
    expect(host.requests).toHaveLength(2)
    const log = await readFile(await app.captureMainLog('concurrent-primary.log'), 'utf8')
    const starts = new Set(
      log
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .filter((record) => record.scope === 'acp' && record.msg === 'agent initialized')
        .map((record) => `${record.runId}:${record.t}`)
    )
    expect(starts.size).toBe(1)
  } finally {
    firstReply.resolve('PRIMARY_BUSY_DONE')
    await host.close()
  }
})

for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
  test(`built-in harness shows automatic compact ${outcome} and restores its milestone`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180000)
    const checkpoint =
      '## Goal\nContinue the current request.\n## Progress\nPRIVATE_COMPACTION_CHECKPOINT: archived evidence reviewed.\n## Evidence\nNo effects executed.\n## Next\nFollow the latest user request.'
    let release!: (text: string) => void
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    let summaries = 0,
      seedReplies = 0
    const host = await capabilityHost(app, async (body) => {
      if (lastUser(body).includes('Create a compact continuation checkpoint')) {
        summaries++
        return summaries === 1 ? pending : checkpoint
      }
      if (!summaries && lastUser(body).includes('SEED_COMPACT_')) {
        seedReplies++
        return (
          '```text\n' + 'archived evidence '.repeat(1000) + '\n```\n\nSEED_READY_' + seedReplies
        )
      }
      return 'COMPACT_CONTINUATION_OK'
    })
    const projectName = `Harness compact ${outcome}`
    try {
      await createProject(host.page, projectName)
      for (let round = 1; round <= 16; round++) {
        await submitPromptViaUi(
          host.page,
          round === 1 ? 'SEED_COMPACT_ONE' : `SEED_COMPACT_${round}`
        )
        await expect
          .poll(
            async () =>
              summaries > 0 ||
              (await host.page.getByText(`SEED_READY_${round}`, { exact: true }).isVisible())
          )
          .toBe(true)
        if (summaries) break
        await expect(
          host.page.getByRole('button', { name: 'Cancel run', exact: true })
        ).toBeHidden()
      }
      const milestone = host.page.getByTestId('context-compaction-activity')
      await expect(milestone.last()).toContainText('Compacting context')
      await expect(milestone.last()).toContainText('Summarizing earlier context')
      await expect(host.page.getByTestId('permission-card')).toHaveCount(0)
      await host.page.screenshot({ path: testInfo.outputPath('compact-in-progress.png') })
      if (outcome === 'cancelled') {
        await host.page.getByRole('button', { name: 'Cancel run', exact: true }).click()
        await expect(milestone.last()).toContainText('Context compaction cancelled')
        release(checkpoint)
        await expect(
          host.page.getByRole('button', { name: 'Cancel run', exact: true })
        ).toBeHidden()
        await submitPromptViaUi(host.page, 'Continue after cancelled compaction.')
      } else if (outcome === 'failed') {
        release('Invalid checkpoint without the required sections.')
        await expect(milestone.last()).toContainText('Context compaction failed')
        await expect(
          host.page.getByRole('button', { name: 'Cancel run', exact: true })
        ).toBeHidden()
        host.page = await app.restart()
        await openProjectSession(host.page, projectName, 'SEED_COMPACT_ONE')
        await expect(host.page.getByTestId('context-compaction-activity').last()).toContainText(
          'Context compaction failed'
        )
        await submitPromptViaUi(host.page, 'Continue after failed compaction.')
      } else release(checkpoint)
      await expect(host.page.getByTestId('context-compaction-activity').last()).toContainText(
        'Context compacted'
      )
      await expect(host.page.getByText('COMPACT_CONTINUATION_OK', { exact: true })).toBeVisible()
      await expect(
        host.page.getByText('PRIVATE_COMPACTION_CHECKPOINT', { exact: false })
      ).toHaveCount(0)
      expect(summaries).toBe(outcome === 'completed' ? 1 : 2)
      await host.page.screenshot({ path: testInfo.outputPath('compact-completed.png') })
      host.page = await app.restart()
      await openProjectSession(host.page, projectName, 'SEED_COMPACT_ONE')
      await expect(host.page.getByTestId('context-compaction-activity').last()).toContainText(
        'Context compacted'
      )
      await submitPromptViaUi(host.page, 'Confirm the restored session continues.')
      await expect(
        host.page.getByText('COMPACT_CONTINUATION_OK', { exact: true }).last()
      ).toBeVisible()
      expect(summaries).toBe(outcome === 'completed' ? 1 : 2)
      await host.page.getByRole('button', { name: 'All projects', exact: true }).click()
      await createProject(host.page, 'Separate compact acceptance session')
      await expect(host.page.getByTestId('context-compaction-activity')).toHaveCount(0)
      await testInfo.attach('compaction-lifecycle', {
        body: JSON.stringify({ outcome, summaries, requests: host.requests.length }),
        contentType: 'application/json'
      })
    } finally {
      release(checkpoint)
      await host.close()
    }
  })
}

test('built-in harness pages original large results without reloading the Skill', async ({
  app
}, testInfo) => {
  test.setTimeout(120000)
  let effects = 0,
    reads = 0
  const host = await capabilityHost(app, (body) => {
    const result = body.messages.at(-1)
    if (result?.role === 'tool') {
      const value = JSON.stringify(result.content)
      if (reads) {
        expect(value).toContain('READER_MIDDLE_42')
        return 'ORIGINAL_RESULT_RECOVERED'
      }
      // The marker belongs to the package, not a Notebook-specific output truncator.
      const blocks =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      const id = blocks.match(/invocationId=("[^"\n]+")/)
      expect(id, blocks.slice(-500)).not.toBeNull()
      expect(blocks).not.toContain('READER_MIDDLE_42')
      reads++
      return {
        tool: 'read_tool_result',
        args: { invocationId: JSON.parse(id![1]), offset: 29500, limit: 2048 }
      }
    }
    effects++
    return { tool: 'load_skill', args: { skill: 'harness-original-evidence' } }
  })
  try {
    await host.page.evaluate(async () => {
      await window.api.settings.createSkill({
        name: 'harness-original-evidence',
        description: 'Synthetic evidence for bounded original reads',
        body: 'x'.repeat(30000) + 'READER_MIDDLE_42' + 'y'.repeat(30000)
      })
    })
    await createProject(host.page, 'Harness original result reader')
    await submitPromptViaUi(
      host.page,
      'Load harness-original-evidence once and recover its middle receipt.'
    )
    await expect(host.page.getByText('ORIGINAL_RESULT_RECOVERED', { exact: true })).toBeVisible({
      timeout: 60000
    })
    expect(effects).toBe(1)
    expect(reads).toBe(1)
    await expect(host.page.getByTestId('permission-card')).toHaveCount(0)
    await host.page.screenshot({ path: testInfo.outputPath('original-result-reader.png') })
  } finally {
    await host.close()
  }
})
