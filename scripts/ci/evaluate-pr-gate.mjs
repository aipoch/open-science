/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { macosGroupsForPlan } from './classify-pr-changes.mjs'

const gateManifest = JSON.parse(
  readFileSync(new URL('./change-impact.json', import.meta.url), 'utf8')
)

function expectedBundlesForLanes(lanes) {
  if (!Array.isArray(lanes) || new Set(lanes).size !== lanes.length) return undefined

  const selected = new Set()
  const declaredBundles = new Set(gateManifest.bundleOrder)
  for (const lane of lanes) {
    if (!gateManifest.laneOrder.includes(lane)) return undefined
    const bundle = gateManifest.laneBundles[lane]
    if (!bundle || !declaredBundles.has(bundle)) return undefined
    selected.add(bundle)
  }
  return gateManifest.bundleOrder.filter((bundle) => selected.has(bundle))
}

export function evaluatePrGate(plan, conclusions, { executionMode = 'lanes' } = {}) {
  const failures = []
  if (plan.macosProfile !== undefined && !['smoke', 'expanded'].includes(plan.macosProfile)) {
    failures.push({ lane: 'preflight', conclusion: 'invalid', reason: 'unsupported macOS profile' })
  }
  if (
    plan.macosProfile === 'smoke' &&
    plan.bundles?.includes('macos_e2e') &&
    (!plan.lanes.includes('e2e_smoke_macos') ||
      plan.lanes.some(
        (lane) =>
          gateManifest.laneBundles[lane] === 'macos_e2e' &&
          !['build', 'e2e_smoke_macos'].includes(lane)
      ))
  ) {
    failures.push({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'short macOS plan must select only its core lane and build'
    })
  }
  // Old trusted plans omit this field and execute the complete legacy matrix. New plans must
  // not be able to omit a selected group while the aggregate matrix job still reports success.
  if (
    plan.macosGroups !== undefined &&
    JSON.stringify(plan.macosGroups) !== JSON.stringify(macosGroupsForPlan(plan))
  ) {
    failures.push({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'macOS groups do not match selected lanes'
    })
  }
  const hasBundlePlan = Array.isArray(plan.bundles)
  const expectedBundles = expectedBundlesForLanes(plan.lanes)
  const hasValidBundlePlan =
    hasBundlePlan &&
    expectedBundles !== undefined &&
    plan.bundles.length === expectedBundles.length &&
    plan.bundles.every((bundle, index) => bundle === expectedBundles[index])
  const selectedExecutions =
    executionMode === 'bundles' ? (hasValidBundlePlan ? plan.bundles : []) : plan.lanes

  if (executionMode !== 'lanes' && executionMode !== 'bundles') {
    failures.push({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: `unsupported execution mode: ${executionMode}`
    })
  }

  if (executionMode === 'bundles' && !hasBundlePlan) {
    failures.push({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'execution bundle plan is missing'
    })
  } else if (executionMode === 'bundles' && !hasValidBundlePlan) {
    failures.push({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'execution bundle plan does not match selected lanes'
    })
  }

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

  for (const execution of selectedExecutions) {
    const conclusion = conclusions[execution] ?? 'missing'
    if (conclusion !== 'success') {
      failures.push({
        lane: execution,
        conclusion,
        reason:
          executionMode === 'bundles'
            ? 'selected execution bundle did not succeed'
            : 'selected lane did not succeed'
      })
    }
  }

  const selected = new Set(selectedExecutions)
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
    selectedLanes: [...plan.lanes],
    selectedBundles: executionMode === 'bundles' && hasValidBundlePlan ? [...plan.bundles] : []
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
  const bundles =
    result.selectedBundles.length === 0
      ? ''
      : `\n- Execution bundles: ${result.selectedBundles.map(escapeHtml).join(', ')}`
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

- Selected lanes: ${result.selectedLanes.map(escapeHtml).join(', ') || '_none_'}${bundles}

### Failures

${failures}
`
}

export function runPrGateCli(environment = process.env) {
  if (!environment.PR_GATE_PLAN) throw new Error('PR_GATE_PLAN is required')
  if (!environment.PR_GATE_NEEDS) throw new Error('PR_GATE_NEEDS is required')

  const plan = JSON.parse(environment.PR_GATE_PLAN)
  if (plan.macosProfile !== undefined && environment.PR_GATE_PLATFORM_POLICY !== 'risk-v1') {
    throw new Error('Risk-based plan requires a compatible workflow')
  }
  const needs = JSON.parse(environment.PR_GATE_NEEDS)
  const conclusions = Object.fromEntries(
    Object.entries(needs).map(([lane, value]) => [lane, value?.result ?? 'missing'])
  )
  const result = evaluatePrGate(plan, conclusions, {
    executionMode: environment.PR_GATE_EXECUTION_MODE ?? 'lanes'
  })
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
