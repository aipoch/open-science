import { expect, test as playwrightTest } from '@playwright/test'
import {
  RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS,
  runtimePerformanceTestTimeoutMs
} from '../scripts/performance/runtime-profile-timeout'
import { createProject, openProjectSession, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

const PROFILE_PROJECT_NAME = 'Runtime performance fixture'
const ACP_PROMPT = 'Summarize the deterministic fixture.'
const ACP_REPLY = `Deterministic reply: ${ACP_PROMPT}`
const NOTEBOOK_PROMPT = 'Profile the notebook lifecycle.'
const NOTEBOOK_REPLY = 'Notebook lifecycle verified for'
const STRESS_PROMPT = 'Run the runtime resource stress journey.'
const STRESS_REPLY = 'Runtime resource stress journey complete.'

const positiveIntegerEnvironment = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

const phaseDurationMs = positiveIntegerEnvironment('OPEN_SCIENCE_PERF_PHASE_MS', 10_000)
const sampleIntervalMs = positiveIntegerEnvironment('OPEN_SCIENCE_PERF_INTERVAL_MS', 1_000)
const stressCycles = positiveIntegerEnvironment('OPEN_SCIENCE_PERF_STRESS_CYCLES', 1)

test('records isolated startup, ACP, Notebook, and recovery resource trends', async ({
  app
}, testInfo) => {
  playwrightTest.setTimeout(runtimePerformanceTestTimeoutMs(stressCycles))
  await app.completeOnboarding()
  await app.configureFakeAgent()
  await app.beginResourceProfile({
    sampleIntervalMs,
    ...(process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT
      ? { outputRoot: process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT }
      : {})
  })

  let result: Awaited<ReturnType<typeof app.finishResourceProfile>> | undefined
  try {
    let page = await app.restart({ resourceProfilePhase: 'startup' })

    await app.markResourceProfilePhase('idle')
    await page.waitForTimeout(phaseDurationMs)
    await app.sampleResourceProfileNow()

    await app.markResourceProfilePhase('workspace')
    await createProject(page, PROFILE_PROJECT_NAME)
    await app.sampleResourceProfileNow()

    await app.markResourceProfilePhase('acp-turn')
    await sendPrompt(page, ACP_PROMPT, ACP_REPLY, RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS)
    await app.sampleResourceProfileNow()

    for (let cycle = 0; cycle < stressCycles; cycle += 1) {
      await app.markResourceProfilePhase('session-stress')
      await sendPrompt(
        page,
        `${STRESS_PROMPT} Cycle ${cycle + 1}.`,
        STRESS_REPLY,
        RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS
      )
      await app.sampleResourceProfileNow()

      await app.markResourceProfilePhase('notebook-tool')
      await sendPrompt(page, NOTEBOOK_PROMPT, NOTEBOOK_REPLY, RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS)
      await app.sampleResourceProfileNow()
    }

    page = await app.restart({ resourceProfilePhase: 'recovery' })
    await page.waitForTimeout(phaseDurationMs)
    await openProjectSession(page, PROFILE_PROJECT_NAME, ACP_PROMPT)
    await expect(page.getByText(STRESS_REPLY, { exact: false }).last()).toBeVisible({
      timeout: RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS
    })
    await app.sampleResourceProfileNow()
  } finally {
    result = await app.finishResourceProfile().catch((error: unknown) => {
      // Fixture teardown may abort the profiler first when Playwright times the test out.
      if (error instanceof Error && error.message === 'Runtime resource profiling is not active.') {
        return undefined
      }
      throw error
    })
  }

  if (!result) throw new Error('Runtime resource profile was not recorded.')

  await testInfo.attach('runtime-resource-summary', {
    path: result.summaryMarkdownPath,
    contentType: 'text/markdown'
  })
  const summary = result.summary
  expect(summary.sampleCount, 'the profile must contain resource samples').toBeGreaterThan(0)
  expect(
    summary.incompleteSampleCount / summary.sampleCount,
    'no more than 10% of resource samples may be incomplete'
  ).toBeLessThanOrEqual(0.1)
  const idle = summary.phases.idle
  const recovery = summary.phases.recovery
  if (!idle || !recovery) throw new Error('The profile must contain idle and recovery phases.')
  expect(idle.includedSampleCount, 'idle must contain a complete resource sample').toBeGreaterThan(
    0
  )
  expect(
    recovery.includedSampleCount,
    'recovery must contain a complete resource sample'
  ).toBeGreaterThan(0)
  expect(
    recovery.processCount.last,
    'recovery must not retain more processes than the stable idle phase'
  ).toBeLessThanOrEqual(idle.processCount.last)
  const recoveryStorage = recovery.storage
  expect(recoveryStorage?.temporaryFileCount.last, 'recovery must leave no temporary files').toBe(0)
  expect(recoveryStorage?.temporaryBytes.last, 'recovery must leave no temporary bytes').toBe(0)
  expect(
    recoveryStorage?.sessionFileCount.last,
    'the journey must persist exactly one Session'
  ).toBe(1)
  expect(
    recoveryStorage?.notebookRunFileCount.last,
    'the journey must reuse exactly one persisted Notebook run file'
  ).toBe(1)
  expect(recoveryStorage?.sessionBytes.last).toBeGreaterThan(0)
  expect(recoveryStorage?.notebookRunBytes.last).toBeGreaterThan(0)
  console.log(`Runtime performance summary: ${result.summaryMarkdownPath}`)
})
