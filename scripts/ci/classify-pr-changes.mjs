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
  const documentationRule = manifest.rules.find((rule) => rule.id === 'documentation')

  const selectFullPlan = (root, reason) => {
    mode = 'full'
    roots.add(root)
    reasonChains.add(reason)
    for (const lane of manifest.laneOrder) lanes.add(lane)
  }

  const visitRule = (rule, path) => {
    roots.add(rule.id)
    for (const capability of rule.capabilities) {
      const reasonPath = rule.id === capability ? [path] : [path, rule.id]
      visitCapability(manifest, capability, reasonPath, lanes, reasonChains, new Set())
    }
  }

  for (const change of changes) {
    const paths = new Set([change.path, change.previousPath].filter(Boolean))
    const destructivePath = ['deleted', 'renamed', 'type-changed', 'unmerged', 'unknown'].includes(
      change.status
    )
      ? [...paths].find(
          (path) => !documentationRule?.paths.some((pattern) => matchesPath(path, pattern))
        )
      : undefined
    if (destructivePath) {
      selectFullPlan('destructive_change', `${destructivePath} -> destructive change -> full`)
      continue
    }

    for (const path of paths) {
      const rules = manifest.rules.filter((rule) =>
        rule.paths.some((pattern) => matchesPath(path, pattern))
      )
      if (rules.length === 0) {
        selectFullPlan('unknown', `${path} -> unknown -> full`)
        continue
      }

      for (const rule of rules) {
        if (!['global', 'owner', 'overlay'].includes(rule.role)) {
          throw new Error(`Unknown change-impact rule role for ${rule.id}: ${rule.role}`)
        }
      }

      const globalRules = rules.filter((rule) => rule.role === 'global' || rule.mode === 'full')
      if (globalRules.length > 0) {
        for (const rule of globalRules) {
          selectFullPlan(rule.id, `${path} -> ${rule.id} -> full`)
        }
        continue
      }

      const ownerRules = rules.filter((rule) => rule.role === 'owner')
      const specificOwners = ownerRules.filter((rule) => !rule.fallbackOwner)
      const fallbackOwners = ownerRules.filter((rule) => rule.fallbackOwner)
      const candidateOwners = specificOwners.length > 0 ? specificOwners : fallbackOwners

      if (candidateOwners.length === 0) {
        selectFullPlan('missing_owner', `${path} -> missing owner -> full`)
        continue
      }
      if (candidateOwners.length > 1) {
        const ownerIds = candidateOwners
          .map((rule) => rule.id)
          .sort()
          .join(', ')
        selectFullPlan('owner_ambiguity', `${path} -> owner ambiguity: ${ownerIds} -> full`)
        continue
      }

      visitRule(candidateOwners[0], path)
      for (const overlay of rules.filter((rule) => rule.role === 'overlay')) {
        visitRule(overlay, path)
      }
    }
  }

  const selectedLanes = manifest.laneOrder.filter((lane) => lanes.has(lane))
  const selectedBundles = new Set()
  const declaredBundles = new Set(manifest.bundleOrder)
  for (const lane of selectedLanes) {
    const bundle = manifest.laneBundles[lane]
    if (!bundle) throw new Error(`Missing execution bundle for selected lane: ${lane}`)
    if (!declaredBundles.has(bundle)) {
      throw new Error(`Unknown execution bundle for selected lane ${lane}: ${bundle}`)
    }
    selectedBundles.add(bundle)
  }

  return {
    schemaVersion: manifest.schemaVersion,
    mode,
    roots: [...roots].sort(),
    lanes: selectedLanes,
    bundles: manifest.bundleOrder.filter((bundle) => selectedBundles.has(bundle)),
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

export function toGitHubOutputPlan(plan) {
  const output = {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    roots: [...plan.roots],
    lanes: [...plan.lanes]
  }
  if (Array.isArray(plan.bundles)) output.bundles = [...plan.bundles]
  return output
}

export function formatPlanSummary(plan) {
  const roots = plan.roots.length === 0 ? '_none_' : plan.roots.map(escapeHtml).join(', ')
  const lanes = plan.lanes.length === 0 ? '_none_' : plan.lanes.map(escapeHtml).join(', ')
  const bundles = plan.bundles?.length > 0 ? plan.bundles.map(escapeHtml).join(', ') : '_none_'
  const reasons =
    plan.reasonChains.length === 0
      ? '- _No changed paths_'
      : plan.reasonChains.map((reason) => `- <code>${escapeHtml(reason)}</code>`).join('\n')

  return `## PR Gate preflight

- Mode: **${escapeHtml(plan.mode)}**
- Roots: ${roots}
- Selected lanes: ${lanes}
- Execution bundles: ${bundles}

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
  const outputPlanJson = JSON.stringify(toGitHubOutputPlan(plan))
  const lanesJson = JSON.stringify(plan.lanes)

  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, `plan=${outputPlanJson}\nlanes=${lanesJson}\n`)
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
