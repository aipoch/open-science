/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyChanges, formatPlanSummary, parseNameStatus } from './classify-pr-changes.mjs'
import {
  createModuleImpactShadowReport,
  formatModuleImpactShadowSummary
} from './module-impact-shadow.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'

const manifestOnlyGraph = Object.freeze({
  status: 'unavailable-manifest-only',
  reason: 'CI authority uses the trusted repository manifest only',
  testFiles: []
})

const unusedModulePlan = Object.freeze({
  mode: 'selective',
  modules: [],
  testFiles: [],
  capabilityOverlays: [],
  fallbackCapabilities: [],
  graphStatus: 'not-used',
  graphReason: 'unit bundle not selected',
  reasonChains: []
})

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

function requireCommit(value, name) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} must be a full 40-character Git commit SHA`)
  }
  return value
}

function changesFromGit(base, head, { cwd = process.cwd(), execute = execFileSync } = {}) {
  const diff = execute('git', ['diff', '--name-status', '-z', base, head], { cwd })
  return parseNameStatus(diff.toString('utf8'))
}

export function runModuleImpactAuthorityCli(
  arguments_ = process.argv.slice(2),
  environment = process.env,
  { cwd = process.cwd(), execute = execFileSync, append = appendFileSync, write } = {}
) {
  const base = requireCommit(argumentValue(arguments_, '--base') ?? environment.BASE_SHA, '--base')
  const head = requireCommit(argumentValue(arguments_, '--head') ?? environment.HEAD_SHA, '--head')
  const changes = changesFromGit(base, head, { cwd, execute })
  const candidatePlan = classifyChanges(changes)
  const modulePlan = candidatePlan.bundles.includes('unit')
    ? createAffectedTestPlan(changes, manifestOnlyGraph)
    : unusedModulePlan
  const report = createModuleImpactShadowReport(candidatePlan, modulePlan)
  const plan = report.resolved
  const planJson = JSON.stringify(plan)
  const lanesJson = JSON.stringify(plan.lanes)

  if (environment.GITHUB_OUTPUT) {
    append(environment.GITHUB_OUTPUT, `plan=${planJson}\nlanes=${lanesJson}\n`)
  } else if (write) {
    write(`${planJson}\n`)
  } else {
    process.stdout.write(`${planJson}\n`)
  }
  if (environment.GITHUB_STEP_SUMMARY) {
    append(environment.GITHUB_STEP_SUMMARY, formatPlanSummary(plan))
    append(environment.GITHUB_STEP_SUMMARY, formatModuleImpactShadowSummary(report))
  }
  return { plan, report }
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runModuleImpactAuthorityCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
