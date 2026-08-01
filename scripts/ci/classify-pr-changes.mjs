/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultManifest = JSON.parse(
  readFileSync(new URL('./change-impact.json', import.meta.url), 'utf8')
)

function matchesPath(path, pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**/', '\u0000')
    .replaceAll('**', '\u0001')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '(?:.*/)?')
    .replaceAll('\u0001', '.*')
  return new RegExp(`^${source}$`).test(path)
}

const statusNames = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type-changed',
  U: 'unmerged'
}

export function parseNameStatus(value) {
  const fields = value.split('\0')
  const changes = []
  let index = 0

  while (index < fields.length && fields[index]) {
    const rawStatus = fields[index++]
    const statusCode = rawStatus[0]
    const status = statusNames[statusCode] ?? 'unknown'

    if (statusCode === 'R' || statusCode === 'C') {
      const previousPath = fields[index++]
      const path = fields[index++]
      changes.push({ path, previousPath, status })
    } else {
      changes.push({ path: fields[index++], status })
    }
  }

  return changes
}

function visitCapability(manifest, capabilityId, path, lanes, reasonChains, visiting) {
  if (visiting.has(capabilityId)) {
    throw new Error(`Change-impact capability cycle: ${[...path, capabilityId].join(' -> ')}`)
  }

  const capability = manifest.capabilities[capabilityId]
  if (!capability) throw new Error(`Unknown change-impact capability: ${capabilityId}`)

  const nextPath = [...path, capabilityId]
  reasonChains.add(nextPath.join(' -> '))
  for (const lane of capability.lanes) lanes.add(lane)

  const nextVisiting = new Set(visiting).add(capabilityId)
  for (const consumer of capability.consumers) {
    visitCapability(manifest, consumer, nextPath, lanes, reasonChains, nextVisiting)
  }
}

export function classifyChanges(changes, manifest = defaultManifest) {
  const lanes = new Set(manifest.alwaysLanes)
  const reasonChains = new Set()
  const roots = new Set()
  let mode = 'selective'

  for (const change of changes) {
    const paths = new Set([change.path, change.previousPath].filter(Boolean))
    for (const path of paths) {
      const rules = manifest.rules.filter((rule) =>
        rule.paths.some((pattern) => matchesPath(path, pattern))
      )
      if (rules.length === 0) {
        mode = 'full'
        roots.add('unknown')
        reasonChains.add(`${path} -> unknown -> full`)
        for (const lane of manifest.laneOrder) lanes.add(lane)
        continue
      }
      for (const rule of rules) {
        roots.add(rule.id)
        if (rule.mode === 'full') {
          mode = 'full'
          reasonChains.add(`${path} -> ${rule.id} -> full`)
          for (const lane of manifest.laneOrder) lanes.add(lane)
          continue
        }
        for (const capability of rule.capabilities) {
          visitCapability(manifest, capability, [path], lanes, reasonChains, new Set())
        }
      }
    }
  }

  return {
    schemaVersion: manifest.schemaVersion,
    mode,
    roots: [...roots].sort(),
    lanes: manifest.laneOrder.filter((lane) => lanes.has(lane)),
    reasonChains: [...reasonChains].sort()
  }
}

export const changeImpactManifestPath = fileURLToPath(
  new URL('./change-impact.json', import.meta.url)
)

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

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function formatPlanSummary(plan) {
  const roots = plan.roots.length === 0 ? '_none_' : plan.roots.map(escapeHtml).join(', ')
  const lanes = plan.lanes.length === 0 ? '_none_' : plan.lanes.map(escapeHtml).join(', ')
  const reasons =
    plan.reasonChains.length === 0
      ? '- _No changed paths_'
      : plan.reasonChains.map((reason) => `- <code>${escapeHtml(reason)}</code>`).join('\n')

  return `## PR Gate preflight

- Mode: **${escapeHtml(plan.mode)}**
- Roots: ${roots}
- Selected lanes: ${lanes}

### Reason chains

${reasons}
`
}

export function runClassifierCli(arguments_ = process.argv.slice(2), environment = process.env) {
  const base = requireCommit(argumentValue(arguments_, '--base') ?? environment.BASE_SHA, '--base')
  const head = requireCommit(argumentValue(arguments_, '--head') ?? environment.HEAD_SHA, '--head')
  const diff = execFileSync('git', ['diff', '--name-status', '-z', base, head])
  const plan = classifyChanges(parseNameStatus(diff.toString('utf8')))
  const planJson = JSON.stringify(plan)
  const lanesJson = JSON.stringify(plan.lanes)

  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, `plan=${planJson}\nlanes=${lanesJson}\n`)
  } else {
    process.stdout.write(`${planJson}\n`)
  }
  if (environment.GITHUB_STEP_SUMMARY) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, formatPlanSummary(plan))
  }
  return plan
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runClassifierCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
