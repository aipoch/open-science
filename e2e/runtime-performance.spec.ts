import { test as playwrightTest } from '@playwright/test'
import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

const PROFILE_PROJECT_NAME = 'Runtime performance fixture'
const ACP_PROMPT = 'Summarize the deterministic fixture.'
const ACP_REPLY = `Deterministic reply: ${ACP_PROMPT}`
const NOTEBOOK_PROMPT = 'Profile the notebook lifecycle.'
const NOTEBOOK_REPLY = 'Notebook lifecycle verified for'

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

test('records isolated startup, ACP, Notebook, and recovery resource trends', async ({
  app
}, testInfo) => {
  playwrightTest.setTimeout(180_000)
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
    await sendPrompt(page, ACP_PROMPT, ACP_REPLY, 60_000)
    await app.sampleResourceProfileNow()

    await app.markResourceProfilePhase('notebook-tool')
    await sendPrompt(page, NOTEBOOK_PROMPT, NOTEBOOK_REPLY, 60_000)
    await app.sampleResourceProfileNow()

    page = await app.restart({ resourceProfilePhase: 'recovery' })
    await page.waitForTimeout(phaseDurationMs)
    await app.sampleResourceProfileNow()
  } finally {
    result = await app.finishResourceProfile()
  }

  await testInfo.attach('runtime-resource-summary', {
    path: result.summaryMarkdownPath,
    contentType: 'text/markdown'
  })
  console.log(`Runtime performance summary: ${result.summaryMarkdownPath}`)
})
