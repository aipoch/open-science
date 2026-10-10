import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import { envPrefix } from '../src/main/notebook/runtime-paths'
import { selectMicromambaCache } from '../src/main/notebook/micromamba-cache'
import { validateAndSeedPackIntoCache } from '../src/main/notebook/pack-content'
import {
  createFromLockArgv,
  micromambaSpawnEnv,
  normalizeExplicitLock,
  resolveMicromamba
} from '../src/main/notebook/micromamba'

// Supply an already provisioned runtime root; never mutate the source installation. OpenCode ACP
// is deterministic unless LIVE_SETTINGS and LIVE_MODEL explicitly select an existing live provider.
// Both routes exercise the real application, MCP/RPC, approvals and kernels.
const sourceRuntime = process.env.OPEN_SCIENCE_E2E_RUNTIME_ROOT
const liveSettings = process.env.OPEN_SCIENCE_E2E_LIVE_SETTINGS
const liveModel = process.env.OPEN_SCIENCE_E2E_LIVE_MODEL
// The Playwright process is not a desktop host; resolve from its explicit override/PATH.
const micromamba = resolveMicromamba({ resourcesPath: '' })
const evidenceRoot = resolve(
  '.scratch/runtime-approval-spec',
  liveSettings ? 'live-evidence' : 'evidence'
)
test.use({ windowMode: 'normal' })

const prepareRuntime = async (page: Page, language: 'python' | 'r'): Promise<void> => {
  const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
  const target = join(dataRoot, 'runtime')
  await mkdir(join(target, 'envs'), { recursive: true })
  const environment = `default-${language}`
  const source = envPrefix(sourceRuntime!, environment)
  const destination = envPrefix(target, environment)
  // Installed conda prefixes are not relocatable (R embeds its original R_HOME). Reconstruct
  // the exact conda environment offline from copied cache data, as data-root relocation does.
  const cache = join(target, 'pkgs')
  if (process.platform === 'darwin') {
    await promisify(execFile)('cp', ['-cR', join(sourceRuntime!, 'pkgs'), cache])
  } else {
    // Extracted caches can exceed Windows MAX_PATH and contain hundreds of thousands of files.
    // The explicit lock only needs package archives; micromamba extracts them in its short cache.
    await cp(join(sourceRuntime!, 'pkgs'), cache, {
      recursive: true,
      filter: (path) => path === join(sourceRuntime!, 'pkgs') || /\.(conda|tar\.bz2)$/.test(path)
    })
  }
  const workingCache = selectMicromambaCache(target)
  const env = micromambaSpawnEnv(target, undefined, { selectCache: () => workingCache })
  const exported = await promisify(execFile)(
    micromamba!,
    ['--no-rc', 'list', '--prefix', source, '--explicit', '--md5'],
    { env, maxBuffer: 16 * 1024 * 1024 }
  )
  const lock = join(target, `${environment}.lock`)
  await writeFile(lock, normalizeExplicitLock(exported.stdout))
  if (workingCache.path !== cache) {
    await validateAndSeedPackIntoCache(cache, lock, workingCache)
  }
  const [command, ...args] = createFromLockArgv(micromamba!, target, destination, lock)
  await promisify(execFile)(command, args, { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  await cp(
    join(sourceRuntime!, language === 'python' ? '.env-ready' : '.r-env-ready'),
    join(target, language === 'python' ? '.env-ready' : '.r-env-ready')
  )
  const environments = await page.evaluate(async () => window.api.runtime.listEnvironments())
  expect(environments[language]).toEqual(
    expect.arrayContaining([expect.objectContaining({ provenance: 'app-managed', runnable: true })])
  )
}

const capture = async (page: Page, name: string): Promise<void> => {
  await mkdir(evidenceRoot, { recursive: true })
  await page.screenshot({ path: join(evidenceRoot, name), fullPage: true })
}

for (const language of ['python', 'r'] as const) {
  for (const profile of ['auto', 'ask'] as const) {
    for (const implicit of profile === 'ask' ? [false, true] : [false]) {
      test(`${language} ${profile} ${implicit ? 'implicit' : 'explicit'} binding is decided once and preserves the next cell`, async ({
        app
      }, testInfo) => {
        test.skip(
          !sourceRuntime ||
            !micromamba ||
            !existsSync(join(sourceRuntime, language === 'python' ? '.env-ready' : '.r-env-ready')),
          'Requires a provisioned OPEN_SCIENCE_E2E_RUNTIME_ROOT with package cache, readiness marker, and Micromamba.'
        )
        test.setTimeout(liveSettings ? 600_000 : 300_000)
        await app.completeOnboarding()
        if (liveSettings && !liveModel) throw new Error('A live model must be explicitly selected.')
        const page = liveSettings
          ? await app.configureLiveAgent(
              liveSettings,
              liveModel!,
              process.env.OPEN_SCIENCE_E2E_LIVE_PROFILE
            )
          : await app.configureFakeAgent()
        await prepareRuntime(page, language)
        await page.evaluate(async (profile) => {
          await window.api.settings.setDefaultPermissionProfile({ profile })
        }, profile)
        await page.reload({ waitUntil: 'domcontentloaded' })
        const projectId = await createProject(page, `${language.toUpperCase()} Runtime ${profile}`)
        await page.evaluate(() => {
          const evidence = { requests: [] as unknown[] }
          Object.assign(window, { runtimeApprovalEvidence: evidence })
          window.api.acp.onPermissionRequest((request) => evidence.requests.push(request))
        })
        const reply = `Runtime ${language} first cell verified: 41.`
        const prompt = liveSettings
          ? `Use the Notebook tools for ${language}. ${implicit ? 'Call notebook_execute directly without select_runtime; let the host choose the default environment.' : `First call select_runtime for the app-managed default-${language} environment.`} Execute exactly ${language === 'python' ? '`runtime_approval_value = 41; print(runtime_approval_value)`' : '`runtime_approval_value <- 41; print(runtime_approval_value)`'}. Do not use Shell, REPL, or any other tools. After successful execution reply exactly: ${reply}`
          : `Verify Runtime approval ${language === 'r' ? 'R' : 'Python'} ${implicit ? 'implicit' : 'explicit'} first cell.`
        await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
        await page.getByRole('button', { name: 'Send message' }).click()
        if (profile === 'ask') {
          const card = page.getByTestId('permission-card')
          await expect(card).toBeVisible({ timeout: liveSettings ? 120_000 : 20_000 })
          await expect(card).toContainText('Later Notebook runs use this environment.')
          const button = card.getByTestId('allow-primary')
          await expect(button).toHaveText('Allow')
          await expect(card.getByRole('button', { name: 'Choose approval scope' })).toHaveCount(0)
          await expect(page.getByText(reply, { exact: true })).toHaveCount(0)
          await capture(page, `${language}-${implicit ? 'implicit' : 'explicit'}-ask.png`)
          // Real keyboard activation in the running Electron app.
          await button.focus()
          await page.keyboard.press('Enter')
          await expect(card).toHaveCount(0)
        }
        await expect(
          page
            .getByText(reply, { exact: true })
            .or(page.getByText(/^E2E fixture failure:/))
            .or(page.getByTestId('permission-card'))
        ).toBeVisible({ timeout: 120_000 })
        await expect(page.getByTestId('permission-card')).toHaveCount(0)
        await expect(page.getByText(/^E2E fixture failure:/)).toHaveCount(0)
        await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 120_000 })
        await expect(page.getByTestId('permission-card')).toHaveCount(0)
        const requestCount = (): Promise<number> =>
          page.evaluate(
            () =>
              (window as unknown as { runtimeApprovalEvidence: { requests: unknown[] } })
                .runtimeApprovalEvidence.requests.length
          )
        expect(await requestCount()).toBe(profile === 'ask' ? 1 : 0)
        await capture(
          page,
          `${language}-${profile}-${implicit ? 'implicit' : 'explicit'}-first.png`
        )
        await page
          .getByRole('textbox', { name: 'Ask anything' })
          .fill(
            liveSettings
              ? `Using the same Notebook ${language} kernel, execute exactly ${language === 'python' ? '`runtime_approval_value += 1; print(runtime_approval_value)`' : '`runtime_approval_value <- runtime_approval_value + 1; print(runtime_approval_value)`'}. Do not initialize the variable again. After the output is 42 reply exactly: Runtime ${language} continued cell verified: 42.`
              : `Verify Runtime approval ${language === 'r' ? 'R' : 'Python'} explicit continued cell.`
          )
        await page.getByRole('button', { name: 'Send message' }).click()
        const continuedReply = page.getByText(`Runtime ${language} continued cell verified: 42.`, {
          exact: true
        })
        await expect(
          continuedReply
            .or(page.getByText(/^E2E fixture failure:/))
            .or(page.getByTestId('permission-card'))
        ).toBeVisible({ timeout: 120_000 })
        await expect(page.getByTestId('permission-card')).toHaveCount(0)
        await expect(page.getByText(/^E2E fixture failure:/)).toHaveCount(0)
        await expect(continuedReply).toBeVisible({ timeout: 120_000 })
        expect(await requestCount()).toBe(profile === 'ask' ? 1 : 0)
        await expect(page.getByTestId('permission-card')).toHaveCount(0)
        await capture(
          page,
          `${language}-${profile}-${implicit ? 'implicit' : 'explicit'}-continued.png`
        )
        if (liveSettings) {
          const sessions = await page.evaluate(
            async () => (await window.api.sessions.loadAll()).sessions
          )
          const session = sessions.find((candidate) => candidate.projectId === projectId)
          expect(session).toBeDefined()
          expect(session!.agentFrameworkId).toBe('opencode')
          expect(session!.agentModel).toContain(liveModel!)
          const runs = await app.readNotebookFixtureRuns(projectId, session!.id)
          const cells = runs.filter(
            (run) => run.kernelKind === language && run.script.includes('runtime_approval_value')
          )
          expect(cells).toHaveLength(2)
          expect(cells.every((run) => run.status === 'completed')).toBe(true)
          expect(cells[0].text.stdout).toContain('41')
          expect(cells[1].text.stdout).toContain('42')
          expect(cells[0].kernelEpochId).toEqual(expect.any(String))
          expect(cells[1].kernelEpochId).toBe(cells[0].kernelEpochId)
          const evidence = JSON.stringify(
            { model: session!.agentModel, framework: session!.agentFrameworkId, runs: cells },
            null,
            2
          )
          const evidencePath = join(
            evidenceRoot,
            `${language}-${profile}-${implicit ? 'implicit' : 'explicit'}-runs.json`
          )
          await writeFile(evidencePath, evidence)
          await testInfo.attach('live-provider-kernel-evidence', {
            path: evidencePath,
            contentType: 'application/json'
          })
        }
        if (profile === 'auto' && !liveSettings) {
          await page
            .getByRole('textbox', { name: 'Ask anything' })
            .fill(`Verify Runtime approval ${language === 'r' ? 'R' : 'Python'} risky cell.`)
          await page.getByRole('button', { name: 'Send message' }).click()
          const risk = page.getByTestId('permission-card')
          await expect(risk).toHaveAttribute(
            'aria-label',
            'Permission request: Review potentially destructive code'
          )
          await expect(risk.getByTestId('allow-primary')).toHaveText('Allow')
          await capture(page, `${language}-auto-independent-code-risk.png`)
          await risk.getByTestId('deny-button').click()
          await expect(
            page.getByText('Risky code denied before execution.', { exact: true })
          ).toBeVisible()
          expect(await requestCount()).toBe(1)
        }
        await testInfo.attach('permission-evidence', {
          body: JSON.stringify(
            await page.evaluate(
              () =>
                (window as unknown as { runtimeApprovalEvidence: unknown }).runtimeApprovalEvidence
            ),
            null,
            2
          ),
          contentType: 'application/json'
        })
      })
    }
  }
}
