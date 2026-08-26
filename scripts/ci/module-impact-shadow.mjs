/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseNameStatus } from './classify-pr-changes.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'

const defaultChangeImpactManifest = JSON.parse(
  readFileSync(new URL('./change-impact.json', import.meta.url), 'utf8')
)

const manifestOnlyGraph = Object.freeze({
  status: 'unavailable-manifest-only',
  reason: 'CI shadow uses the repository manifest only',
  testFiles: []
})

function unique(values) {
  return [...new Set(values)]
}

function ordered(values, order) {
  const positions = new Map(order.map((value, index) => [value, index]))
  return unique(values).sort((left, right) => {
    const leftPosition = positions.get(left)
    const rightPosition = positions.get(right)
    if (leftPosition !== undefined && rightPosition !== undefined) {
      return leftPosition - rightPosition
    }
    if (leftPosition !== undefined) return -1
    if (rightPosition !== undefined) return 1
    return left < right ? -1 : left > right ? 1 : 0
  })
}

function strings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

function capabilityLanes(capabilityIds, manifest) {
  const lanes = new Set(manifest.alwaysLanes)
  const visited = new Set()

  const visit = (capabilityId, visiting) => {
    if (visiting.has(capabilityId)) {
      throw new Error(`Change-impact capability cycle: ${[...visiting, capabilityId].join(' -> ')}`)
    }
    if (visited.has(capabilityId)) return
    const capability = manifest.capabilities[capabilityId]
    if (!capability) throw new Error(`Unknown change-impact capability: ${capabilityId}`)

    const nextVisiting = new Set(visiting).add(capabilityId)
    for (const lane of capability.lanes) lanes.add(lane)
    for (const consumer of capability.consumers) visit(consumer, nextVisiting)
    visited.add(capabilityId)
  }

  for (const capabilityId of capabilityIds) visit(capabilityId, new Set())
  return ordered(lanes, manifest.laneOrder)
}

export function requiredLanesForModulePlan(
  modulePlan,
  changeImpactManifest = defaultChangeImpactManifest
) {
  if (modulePlan.mode === 'full') return [...changeImpactManifest.laneOrder]
  return capabilityLanes(
    [...strings(modulePlan.fallbackCapabilities), ...strings(modulePlan.capabilityOverlays)],
    changeImpactManifest
  )
}

function bundlesForLanes(lanes, manifest) {
  const bundles = lanes.map((lane) => {
    const bundle = manifest.laneBundles[lane]
    if (!bundle) throw new Error(`Missing execution bundle for selected lane: ${lane}`)
    return bundle
  })
  return ordered(bundles, manifest.bundleOrder)
}

export function resolveAuthoritativePlan(
  candidatePlan,
  modulePlan,
  changeImpactManifest = defaultChangeImpactManifest
) {
  if (candidatePlan.mode === 'full' || !strings(candidatePlan.bundles).includes('unit')) {
    return candidatePlan
  }

  const moduleReasons = strings(modulePlan.reasonChains)
  if (modulePlan.mode === 'full') {
    return {
      schemaVersion: candidatePlan.schemaVersion ?? changeImpactManifest.schemaVersion,
      mode: 'full',
      roots: unique([...strings(candidatePlan.roots), 'module_impact']).sort(),
      lanes: [...changeImpactManifest.laneOrder],
      bundles: [...changeImpactManifest.bundleOrder],
      reasonChains: unique([...strings(candidatePlan.reasonChains), ...moduleReasons]).sort()
    }
  }

  const lanes = ordered(
    [
      ...strings(candidatePlan.lanes),
      ...requiredLanesForModulePlan(modulePlan, changeImpactManifest)
    ],
    changeImpactManifest.laneOrder
  )
  return {
    ...candidatePlan,
    roots: unique([
      ...strings(candidatePlan.roots),
      ...strings(modulePlan.modules).map((moduleId) => `module:${moduleId}`)
    ]).sort(),
    lanes,
    bundles: bundlesForLanes(lanes, changeImpactManifest),
    reasonChains: unique([...strings(candidatePlan.reasonChains), ...moduleReasons]).sort()
  }
}

export function createModuleImpactShadowReport(
  authoritativePlan,
  modulePlan,
  changeImpactManifest = defaultChangeImpactManifest
) {
  if (
    !authoritativePlan ||
    typeof authoritativePlan !== 'object' ||
    Array.isArray(authoritativePlan)
  ) {
    throw new Error('Authoritative plan must be an object')
  }
  if (!modulePlan || typeof modulePlan !== 'object' || Array.isArray(modulePlan)) {
    throw new Error('Module plan must be an object')
  }

  const requiredLanes = requiredLanesForModulePlan(modulePlan, changeImpactManifest)
  const selectedLanes = ordered(strings(authoritativePlan.lanes), changeImpactManifest.laneOrder)
  const selectedLaneSet = new Set(selectedLanes)
  const requiredLaneSet = new Set(requiredLanes)
  const missingLanes = requiredLanes.filter((lane) => !selectedLaneSet.has(lane))
  const additionalAuthoritativeLanes = selectedLanes.filter((lane) => !requiredLaneSet.has(lane))
  const modeAgreement = authoritativePlan.mode === modulePlan.mode
  const disagreements = []
  const resolved = resolveAuthoritativePlan(authoritativePlan, modulePlan, changeImpactManifest)

  if (!modeAgreement) {
    disagreements.push(
      `mode: authoritative ${String(authoritativePlan.mode)} != shadow ${String(modulePlan.mode)}`
    )
  }
  if (missingLanes.length > 0) {
    disagreements.push(`missing authoritative lanes: ${missingLanes.join(', ')}`)
  }
  if (additionalAuthoritativeLanes.length > 0) {
    disagreements.push(`additional authoritative lanes: ${additionalAuthoritativeLanes.join(', ')}`)
  }

  return {
    schemaVersion: 1,
    enforcement: 'blocking',
    authoritative: {
      mode: authoritativePlan.mode,
      roots: strings(authoritativePlan.roots).sort(),
      lanes: selectedLanes,
      bundles: ordered(strings(authoritativePlan.bundles), changeImpactManifest.bundleOrder),
      reasonChains: strings(authoritativePlan.reasonChains).sort()
    },
    shadow: {
      mode: modulePlan.mode,
      modules: strings(modulePlan.modules).sort(),
      testFiles: strings(modulePlan.testFiles).sort(),
      capabilityOverlays: strings(modulePlan.capabilityOverlays).sort(),
      fallbackCapabilities: strings(modulePlan.fallbackCapabilities).sort(),
      graphStatus: modulePlan.graphStatus,
      graphReason: modulePlan.graphReason,
      reasonChains: strings(modulePlan.reasonChains).sort()
    },
    resolved,
    comparison: {
      modeAgreement,
      coverage: missingLanes.length === 0 ? 'covered' : 'gap',
      requiredLanes,
      selectedLanes,
      missingLanes,
      additionalAuthoritativeLanes,
      disagreements
    }
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

function inlineList(values) {
  return values.length === 0
    ? '_none_'
    : values.map((value) => `<code>${escapeHtml(value)}</code>`).join(', ')
}

function bulletList(values) {
  return values.length === 0
    ? '- None'
    : values.map((value) => `- <code>${escapeHtml(value)}</code>`).join('\n')
}

export function formatModuleImpactShadowSummary(report) {
  return `## Module impact authority

- Enforcement: **${escapeHtml(report.enforcement)}**
- Candidate mode: **${escapeHtml(report.authoritative.mode)}**
- Module mode: **${escapeHtml(report.shadow.mode)}**
- Resolved mode: **${escapeHtml(report.resolved.mode)}**
- Candidate coverage: **${escapeHtml(report.comparison.coverage)}**
- CodeGraph: **${escapeHtml(report.shadow.graphStatus)}**${report.shadow.graphReason ? ` (${escapeHtml(report.shadow.graphReason)})` : ''}

### Module selection

- Modules: ${inlineList(report.shadow.modules)}
- Tests: ${inlineList(report.shadow.testFiles)}
- Capability overlays: ${inlineList(report.shadow.capabilityOverlays)}
- Fallback capabilities: ${inlineList(report.shadow.fallbackCapabilities)}

### Required versus candidate lanes

- Required lanes: ${inlineList(report.comparison.requiredLanes)}
- Candidate lanes: ${inlineList(report.comparison.selectedLanes)}
- Resolved lanes: ${inlineList(report.resolved.lanes)}
- Missing lanes: ${inlineList(report.comparison.missingLanes)}
- Additional candidate lanes: ${inlineList(report.comparison.additionalAuthoritativeLanes)}

### Candidate disagreements

${bulletList(report.comparison.disagreements)}

### Candidate reason chains

${bulletList(report.authoritative.reasonChains)}

### Module reason chains

${bulletList(report.shadow.reasonChains)}

### Resolved reason chains

${bulletList(report.resolved.reasonChains)}
`
}

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

function parseAuthoritativePlan(value) {
  if (!value) throw new Error('Authoritative plan JSON is required')
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Authoritative plan must be valid JSON')
  }
}

export function runModuleImpactShadowCli(
  arguments_ = process.argv.slice(2),
  environment = process.env,
  { cwd = process.cwd(), execute = execFileSync, append = appendFileSync, write } = {}
) {
  const base = requireCommit(argumentValue(arguments_, '--base') ?? environment.BASE_SHA, '--base')
  const head = requireCommit(argumentValue(arguments_, '--head') ?? environment.HEAD_SHA, '--head')
  const authoritativePlan = parseAuthoritativePlan(
    argumentValue(arguments_, '--authoritative-plan') ??
      environment.AUTHORITATIVE_PLAN ??
      environment.PR_GATE_PLAN
  )
  const changes = changesFromGit(base, head, { cwd, execute })
  const modulePlan = createAffectedTestPlan(changes, manifestOnlyGraph)
  const report = createModuleImpactShadowReport(authoritativePlan, modulePlan)
  const output = `${JSON.stringify(report)}\n`

  if (write) write(output)
  else process.stdout.write(output)
  if (environment.GITHUB_STEP_SUMMARY) {
    append(environment.GITHUB_STEP_SUMMARY, formatModuleImpactShadowSummary(report))
  }
  return report
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runModuleImpactShadowCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
