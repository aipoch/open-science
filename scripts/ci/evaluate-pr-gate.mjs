/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function evaluatePrGate(plan, conclusions) {
  const failures = []

  if (plan.schemaVersion !== 1) {
    failures.push({
      lane: 'preflight',
      conclusion: conclusions.preflight ?? 'missing',
      reason: `unsupported plan schema version: ${plan.schemaVersion}`
    })
  }
  if (conclusions.preflight !== 'success') {
    failures.push({
      lane: 'preflight',
      conclusion: conclusions.preflight ?? 'missing',
      reason: 'preflight did not succeed'
    })
  }

  for (const lane of plan.lanes) {
    const conclusion = conclusions[lane] ?? 'missing'
    if (conclusion !== 'success') {
      failures.push({
        lane,
        conclusion,
        reason: 'selected lane did not succeed'
      })
    }
  }

  const selected = new Set(plan.lanes)
  for (const [lane, conclusion] of Object.entries(conclusions)) {
    if (
      lane !== 'preflight' &&
      !selected.has(lane) &&
      conclusion !== 'success' &&
      conclusion !== 'skipped'
    ) {
      failures.push({
        lane,
        conclusion,
        reason: 'unselected lane executed unsuccessfully'
      })
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    selectedLanes: [...plan.lanes]
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function formatPrGateSummary(result) {
  const failures =
    result.failures.length === 0
      ? '- None'
      : result.failures
          .map(
            ({ lane, conclusion, reason }) =>
              `- <code>${escapeHtml(lane)}</code>: **${escapeHtml(conclusion)}** — ${escapeHtml(reason)}`
          )
          .join('\n')

  return `## PR Gate

Result: **${result.ok ? 'pass' : 'fail'}**

- Selected lanes: ${result.selectedLanes.map(escapeHtml).join(', ') || '_none_'}

### Failures

${failures}
`
}

export function runPrGateCli(environment = process.env) {
  if (!environment.PR_GATE_PLAN) throw new Error('PR_GATE_PLAN is required')
  if (!environment.PR_GATE_NEEDS) throw new Error('PR_GATE_NEEDS is required')

  const plan = JSON.parse(environment.PR_GATE_PLAN)
  const needs = JSON.parse(environment.PR_GATE_NEEDS)
  const conclusions = Object.fromEntries(
    Object.entries(needs).map(([lane, value]) => [lane, value?.result ?? 'missing'])
  )
  const result = evaluatePrGate(plan, conclusions)
  const summary = formatPrGateSummary(result)

  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, summary)
  else process.stdout.write(summary)
  if (!result.ok) process.exitCode = 1
  return result
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runPrGateCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
