import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { expectCompletedAssistant, submitPromptViaUi } from './fixtures/conversation'
import { configureWebModel, startWebModel, type ModelRequest } from './fixtures/web-model'
import type { WebResult } from '../src/shared/web-tools'

const prompt = 'Read https://example.org/ with web_fetch and report WEB_FETCH_PUBLIC_OK.'
const projectName = 'Public webpage evidence acceptance'

// The model is a local fixture. Search and fetch use the application's public network adapters.
test('anonymous Exa search → fetch → citation on the public network', async ({ app }, testInfo) => {
  const label = 'exa'
  const query = 'NASA black holes event horizon science'
  const domain = 'nasa.gov'
  const bodyMarker = 'black hole'
  test.setTimeout(180_000)
  const requests: ModelRequest[] = []
  const requestPaths: string[] = []
  const evidence: WebResult[] = []
  let networkState: Awaited<ReturnType<typeof app.captureWebNetworkState>> | undefined
  let selectedUrl = ''
  const marker = `WEB_CHAIN_OK_${label}`
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      try {
        collect(JSON.parse(value))
      } catch {
        /* Ordinary message text. */
      }
    } else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>
      if (row.schema === 'open-science.web.v1' || row.schema === 'open-science.web.v2') {
        if (!evidence.some((item) => item.invocation_id === row.invocation_id))
          evidence.push(row as WebResult)
      } else Object.values(row).forEach(collect)
    }
  }
  const gateway = await startWebModel(
    'web-chain-fixture',
    (body, path) => {
      requests.push(body)
      requestPaths.push(path)
      collect(body.messages)
      const search = evidence.find((item) => item.operation === 'search')
      const fetched = evidence.find((item) => item.operation === 'fetch')
      const operation = !search
        ? 'web_search'
        : search.status === 'ok' && !fetched
          ? 'web_fetch'
          : undefined
      if (search && !selectedUrl)
        selectedUrl =
          search.sources.find((source) => new URL(source.url).hostname === domain)?.url ??
          search.sources[0]?.url ??
          ''
      const tool = body.tools!.find((item) =>
        (item.name ?? item.function?.name)?.endsWith(`__${operation}`)
      )
      const name = tool?.name ?? tool?.function?.name ?? 'missing_web_tool'
      const args =
        operation === 'web_search'
          ? {
              query,
              max_results: 3,
              allowed_domains: [domain]
            }
          : { url: selectedUrl, max_chars: 8000 }
      const answer =
        fetched?.status === 'ok'
          ? `${marker}: The fetched page contains “${bodyMarker}”. [source](${selectedUrl}).`
          : `WEB_CHAIN_FAILED_${label}`
      return operation ? { id: `chain-${requests.length}`, name, args } : answer
    },
    { probe: 'minimal', usage: { prompt_tokens: 100, completion_tokens: 10 } }
  )
  try {
    const page = await app.completeOnboarding()
    const initialSettings = await page.evaluate(() => window.api.settings.getSettings())
    networkState = await app.captureWebNetworkState()
    expect(initialSettings.networkProxy?.mode ?? 'system').toBe('system')
    await configureWebModel(page, gateway.baseUrl, {
      name: 'Web chain fixture',
      model: 'web-chain-fixture',
      key: 'local-fixture-only'
    })
    const projectId = await createProject(page, `Real Web chain ${label}`)
    await submitPromptViaUi(page, `Search for ${query}, fetch a returned source, and cite its URL.`)
    await expect(page.getByText(new RegExp(`WEB_CHAIN_(?:OK|FAILED)_${label}`))).toBeVisible({
      timeout: 100000
    })
    expect(evidence.map(({ operation, status, error }) => ({ operation, status, error }))).toEqual([
      { operation: 'search', status: 'ok', error: undefined },
      { operation: 'fetch', status: 'ok', error: undefined }
    ])
    expect(evidence[0].provider?.id).toBe('exa')
    expect(evidence[0].provider?.auth_mode).toBe('anonymous')
    expect(evidence[0].attempts).toHaveLength(1)
    expect(evidence[1].document?.text.toLowerCase()).toContain(bodyMarker.toLowerCase())
    expect(evidence[1].request).toMatchObject({ url: selectedUrl })
    expect(evidence[0].sources.map(({ url }) => url)).toContain(selectedUrl)
    expect(requests).toHaveLength(3)
    expect(requestPaths).toEqual(Array(3).fill('/v1/chat/completions'))
    expect(
      requests.every((item) => !item.tools!.some((tool) => tool.type?.startsWith('web_search')))
    ).toBe(true)
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'source', exact: true })).toHaveAttribute(
      'href',
      selectedUrl
    )
    expect(await expectCompletedAssistant(page, marker, { projectId })).toContain(selectedUrl)
    await page.screenshot({
      path: testInfo.outputPath(`real-search-fetch-citation-${label}.png`),
      fullPage: true
    })
  } finally {
    const uiState = {
      manualRetryButtons: await app.page
        .getByRole('button', { name: 'Retry', exact: true })
        .count()
        .catch(() => undefined),
      permissionCards: await app.page
        .getByTestId('permission-card')
        .count()
        .catch(() => undefined)
    }
    await testInfo.attach('real-web-chain-evidence', {
      body: JSON.stringify(
        {
          uiState,
          query,
          domain,
          requestPaths,
          positioning: {
            marker: bodyMarker,
            offset: evidence
              .find(({ operation }) => operation === 'fetch')
              ?.document?.text.toLowerCase()
              .indexOf(bodyMarker.toLowerCase())
          },
          networkState,
          primaryModel: 'deterministic local fixture; not paid native account evidence',
          publicProviderNetworking:
            'actual app Exa MCP and independent fetch; inherited system proxy retained',
          requests: requests.length,
          results: evidence.map(
            ({
              schema,
              operation,
              status,
              provider,
              attempts,
              duration_ms,
              sources,
              document,
              error
            }) => ({
              schema,
              operation,
              status,
              provider,
              attempts,
              duration_ms,
              sources: sources.map(({ url, title }) => ({ url, title })),
              document: document
                ? {
                    final_url: document.final_url,
                    sha256: document.sha256,
                    extraction_method: document.extraction_method
                  }
                : undefined,
              error
            })
          )
        },
        null,
        2
      ),
      contentType: 'application/json'
    })
    await gateway.close()
  }
})

// This is an explicit public-network smoke test. It exercises production DNS/IP/redirect/proxy
// checks; deterministic attack fixtures live in src/main/web/*.test.ts. No loopback allowlist or
// transport replacement is installed in the app under test.
test('built-in auto fetch shows public evidence and blocked-target failure, then replays offline', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  const requests: ModelRequest[] = []
  const gateway = await startWebModel('web-fetch-acceptance', (body) => {
    requests.push(body)
    const user = JSON.stringify(
      body.messages.findLast((message) => message.role === 'user')?.content
    )
    const blocked = user.includes('WEB_FETCH_BLOCKED_OK')
    const cancelled = user.includes('WEB_FETCH_CANCELLED')
    let previous: { document?: { snapshot_id: string; next_cursor?: string } } | undefined
    const previousContent = body.messages.at(-1)?.content
    try {
      previous = JSON.parse(
        typeof previousContent === 'string'
          ? previousContent
          : Array.isArray(previousContent)
            ? previousContent.map((item: { text?: string }) => item.text ?? '').join('\n')
            : ''
      )
    } catch {
      /* User text and non-envelope messages are not tool evidence. */
    }
    const continuation = !blocked && !cancelled && previous?.document?.next_cursor
    const call = body.messages.at(-1)?.role !== 'tool' || !!continuation
    const tool = body.tools?.find(({ function: definition }) =>
      definition.name.endsWith('__web_fetch')
    )
    const args = continuation
      ? { snapshot_id: previous!.document!.snapshot_id, cursor: continuation, max_chars: 8000 }
      : {
          url: blocked
            ? 'http://127.0.0.1/private'
            : cancelled
              ? 'https://httpbin.org/delay/10?open_science_acceptance=1'
              : 'https://example.org/',
          ...(!blocked && !cancelled ? { max_chars: 20 } : {})
        }
    if (call)
      return {
        id: `fetch-${requests.length}`,
        name: tool?.function.name ?? 'missing_web_fetch',
        args
      }
    return blocked ? 'WEB_FETCH_BLOCKED_OK' : 'WEB_FETCH_PUBLIC_OK'
  })
  try {
    let page = await app.completeOnboarding()
    await configureWebModel(page, gateway.baseUrl, {
      name: 'Web fetch acceptance',
      model: 'web-fetch-acceptance',
      key: 'local-fixture'
    })
    const projectId = await createProject(page, projectName)
    await submitPromptViaUi(page, prompt)
    await expect(page.getByText('WEB_FETCH_PUBLIC_OK', { exact: true })).toBeVisible({
      timeout: 90000
    })
    await expectCompletedAssistant(page, 'WEB_FETCH_PUBLIC_OK')
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    await page.getByTestId('tool-group-header').first().click()
    const publicRow = page.getByTestId('tool-chip').filter({ hasText: 'Web Fetch' }).first()
    await expect(publicRow).toContainText('Completed')
    await expect(publicRow).toHaveAttribute('aria-expanded', 'false')
    await publicRow.click()
    const publicDetails = page.getByTestId('tool-web-fetch-details').first()
    await expect(publicDetails).toContainText('Partial page text')
    await expect(publicDetails.locator('pre')).toHaveText('This domain is for u')
    await publicDetails.getByText('Details', { exact: true }).click()
    await expect(publicDetails).toContainText('https://example.org/')
    await expect(publicDetails).toContainText('Fetched at')
    const continuationRow = page.getByTestId('tool-chip').filter({ hasText: 'Web Fetch' }).nth(1)
    await continuationRow.click()
    const continuationDetails = page.getByTestId('tool-web-fetch-details').nth(1)
    await expect(continuationDetails).toContainText('documentation examples')
    await expect(continuationDetails).not.toContainText('Partial page text')
    await page.screenshot({ path: testInfo.outputPath('public-fetch-success.png'), fullPage: true })

    await submitPromptViaUi(
      page,
      'Read http://127.0.0.1/private with web_fetch and report WEB_FETCH_BLOCKED_OK.'
    )
    await expect(page.getByText('WEB_FETCH_BLOCKED_OK', { exact: true })).toBeVisible({
      timeout: 90000
    })
    await expectCompletedAssistant(page, 'WEB_FETCH_BLOCKED_OK')
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    await page
      .getByRole('button', { name: /Fetched a page 1 step/ })
      .last()
      .click()
    const blockedRow = page.getByTestId('tool-chip').filter({ hasText: 'Web Fetch' }).last()
    await expect(blockedRow).toContainText('Failed')
    await blockedRow.click()
    const blockedDetails = page.getByTestId('tool-web-fetch-details').last()
    await expect(blockedDetails).toContainText('This address is not a supported public web page.')
    await page.screenshot({ path: testInfo.outputPath('public-fetch-blocked.png'), fullPage: true })

    await submitPromptViaUi(
      page,
      'Read https://httpbin.org/delay/10?open_science_acceptance=1 with web_fetch and report WEB_FETCH_CANCELLED.'
    )
    await expect(page.getByTestId('tool-group-header').last()).toContainText(
      'Using tool: Web Fetch',
      { timeout: 30000 }
    )
    await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    const cancelledGroup = page.getByTestId('tool-group-header').last()
    if ((await cancelledGroup.getAttribute('aria-expanded')) !== 'true')
      await cancelledGroup.click()
    const cancelledRow = page.getByTestId('tool-chip').filter({ hasText: 'Web Fetch' }).last()
    await expect(cancelledRow).toContainText('Cancelled')
    if ((await cancelledRow.getAttribute('aria-expanded')) !== 'true') await cancelledRow.click()
    await expect(page.getByTestId('tool-web-fetch-details').last()).toContainText('Cancelled')
    await expect(page.getByTestId('tool-web-fetch-details').last()).not.toContainText(
      'Page excerpt'
    )
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath('public-fetch-cancelled.png'),
      fullPage: true
    })

    const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
    const evidenceRoot = join(dataRoot, 'web-evidence')
    const snapshotFiles = (await readdir(evidenceRoot, { recursive: true })).filter((name) =>
      /^[a-f0-9]{64}[\\/][a-f0-9-]{36}\.json$/.test(String(name))
    )
    expect(snapshotFiles).toHaveLength(1)
    const snapshotPath = join(evidenceRoot, String(snapshotFiles[0]))
    const snapshotBefore = await readFile(snapshotPath, 'utf8')
    const modelCallsBefore = requests.length
    expect(modelCallsBefore).toBe(6)
    expect(JSON.stringify(requests)).toContain('open-science.web.v1')
    const session = (
      await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    ).find((item) => item.projectId === projectId)!

    // Make outbound network unusable before restarting. Opening saved
    // details must preserve the committed text and timestamps without model calls or new snapshots.
    await page.evaluate(async () => {
      await window.api.settings.setNetworkProxy({
        mode: 'manual',
        server: 'http://127.0.0.1:1',
        bypassRules: 'localhost,127.0.0.1'
      })
    })
    page = await app.restart()
    await openProjectSession(page, projectName, prompt)
    for (const group of await page.getByTestId('tool-group-header').all()) {
      if ((await group.getAttribute('aria-expanded')) !== 'true') {
        await group.click()
      }
    }
    const replayRows = page.getByTestId('tool-chip').filter({ hasText: 'Web Fetch' })
    await expect(replayRows).toHaveCount(4)
    const replayPublic = replayRows.first()
    if ((await replayPublic.getAttribute('aria-expanded')) !== 'true') await replayPublic.click()
    await expect(page.getByTestId('tool-web-fetch-details').first()).toContainText(
      'Partial page text'
    )
    const replayContinuation = replayRows.nth(1)
    if ((await replayContinuation.getAttribute('aria-expanded')) !== 'true')
      await replayContinuation.click()
    await expect(page.getByTestId('tool-web-fetch-details').nth(1)).toContainText(
      'documentation examples'
    )
    const replayDetails = page.getByTestId('tool-web-fetch-details').first()
    await replayDetails.getByText('Details', { exact: true }).click()
    await expect(replayDetails).toContainText('Fetched at')
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    expect(await readFile(snapshotPath, 'utf8')).toBe(snapshotBefore)
    expect(
      (await readdir(evidenceRoot, { recursive: true })).filter((name) =>
        /^[a-f0-9]{64}[\\/][a-f0-9-]{36}\.json$/.test(String(name))
      )
    ).toEqual(snapshotFiles)
    expect(requests).toHaveLength(modelCallsBefore)
    await page.screenshot({
      path: testInfo.outputPath('public-fetch-offline-replay.png'),
      fullPage: true
    })
    await testInfo.attach('web-fetch-session-evidence', {
      body: JSON.stringify({
        publicNetwork: true,
        sessionId: session.id,
        projectId,
        modelCalls: requests.length,
        snapshots: snapshotFiles.length,
        snapshotUnchangedAfterRestart: true,
        permissions: 'auto; no approval interaction',
        replay: 'default-enabled web tools; outbound proxy unavailable'
      }),
      contentType: 'application/json'
    })
  } finally {
    await gateway.close()
  }
})
