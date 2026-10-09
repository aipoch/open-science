/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadModuleImpactManifest } from './load-module-impact.mjs'

const workflowContractTest = 'scripts/ci/pr-gate-workflow.test.ts'
const defaultModuleManifest = loadModuleImpactManifest()

const defaultManifest = JSON.parse(
  readFileSync(new URL('./change-impact.json', import.meta.url), 'utf8')
)

export function matchesPath(path, pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**/', '\u0000')
    .replaceAll('**', '\u0001')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '(?:.*/)?')
    .replaceAll('\u0001', '.*')
  return new RegExp(`^${source}$`).test(path)
}

// Regression data belongs to test suites, not the production dependency graph.
export function fixtureTestPatterns(path, manifest = defaultManifest) {
  return (manifest.testFixtureSuites ?? [])
    .filter((suite) => suite.paths.some((pattern) => matchesPath(path, pattern)))
    .flatMap((suite) => suite.tests)
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

export function classifyChanges(
  changes,
  manifest = defaultManifest,
  { moduleManifest = defaultModuleManifest, registrationModules = [] } = {}
) {
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

  const visitModule = (id, path) => {
    const module = moduleManifest.modules[id]
    visitRule(
      {
        id: `module:${id}`,
        capabilities: [module.fallbackCapability, ...module.capabilityOverlays]
      },
      path
    )
    // Even modules whose fallback capability is static-only must execute their evidence.
    lanes.add('unit_macos')
  }

  for (const change of changes) {
    const paths = new Set([change.path, change.previousPath].filter(Boolean))
    const destructivePath = ['deleted', 'renamed', 'type-changed', 'unmerged', 'unknown'].includes(
      change.status
    )
      ? [...paths].find(
          (path) =>
            !(
              ['deleted', 'renamed'].includes(change.status) &&
              fixtureTestPatterns(path, manifest).length > 0
            ) &&
            (!documentationRule?.paths.some((pattern) => matchesPath(path, pattern)) ||
              Object.values(moduleManifest.modules).some((module) =>
                module.ownerPaths.includes(path)
              ))
        )
      : undefined
    if (destructivePath) {
      selectFullPlan('destructive_change', `${destructivePath} -> destructive change -> full`)
      continue
    }

    for (const path of paths) {
      // Only the revision reader can approve additive registration data. Unvalidated
      // registrations, the root manifest and executable CI policy retain global routing.
      const registration = /^scripts\/ci\/module-impact\/([a-z][a-z0-9_]*)\.json$/.exec(path)
      if (registration && registrationModules.includes(registration[1])) {
        roots.add('module_registration')
        visitModule(registration[1], path)
        continue
      }
      // This Vitest contract verifies the workflow; it is not an executable CI input.
      if (path === workflowContractTest) {
        roots.add('ci_workflow_contract_test')
        reasonChains.add(`${path} -> workflow contract -> direct portable test`)
        for (const lane of ['format', 'lint', 'typecheck_node', 'unit_macos']) lanes.add(lane)
        continue
      }
      const rules = manifest.rules.filter((rule) =>
        rule.paths.some((pattern) => matchesPath(path, pattern))
      )
      // Directory placement is not risk evidence: exact registered owners can bound
      // resources and packages, while global rules always take precedence.
      const owners =
        /^(resources|test|packages)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
          ? Object.entries(moduleManifest.modules).filter(([, module]) =>
              module.ownerPaths.includes(path)
            )
          : []
      if (
        rules.length === 0 &&
        owners.length === 0 &&
        fixtureTestPatterns(path, manifest).length === 0
      ) {
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

      if (fixtureTestPatterns(path, manifest).length > 0) {
        roots.add('test_fixture')
        reasonChains.add(`${path} -> regression fixture -> direct test suites`)
        for (const lane of ['format', 'lint', 'unit_macos']) lanes.add(lane)
        continue
      }

      if (owners.length > 1) {
        selectFullPlan('owner_ambiguity', `${path} -> multiple module owners -> full`)
        continue
      }
      if (
        owners.length === 1 &&
        !rules.some((rule) => rule.role === 'owner' && rule !== documentationRule)
      ) {
        visitModule(owners[0][0], path)
        // Keep every existing platform/domain requirement as well as the exact owner.
        for (const rule of rules) visitRule(rule, path)
        continue
      }

      const ownerRules = rules.filter((rule) => rule.role === 'owner')
      const specificOwners = ownerRules.filter((rule) => !rule.fallbackOwner)
      const fallbackOwners = ownerRules.filter((rule) => rule.fallbackOwner)
      // Packaged documentation retains its domain checks as well as documentation checks.
      // The generic documentation rule is not a competing domain owner.
      const domainOwners = specificOwners.filter((rule) => rule !== documentationRule)
      const candidateOwners =
        domainOwners.length > 0
          ? domainOwners
          : specificOwners.length > 0
            ? specificOwners
            : fallbackOwners

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
      if (rules.includes(documentationRule) && candidateOwners[0] !== documentationRule) {
        visitRule(documentationRule, path)
      }
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

// Apply platform policy after dependency/consumer expansion, using trusted base code.
export function platformExecutionPlan(plan, changes, event) {
  if (!['pull_request', 'merge_group'].includes(event)) return plan
  const paths = changes.flatMap(({ path, previousPath }) =>
    [path, previousPath].filter((value) => value && value !== workflowContractTest)
  )
  const criticalDesktopPaths = defaultManifest.rules.find(
    ({ id }) => id === 'critical_desktop_runtime'
  ).paths
  const nativeMainPaths = [
    'src/main/*shell*.ts',
    'src/main/*process*.ts',
    'src/main/menu*.ts',
    'src/main/shortcut*.ts',
    'src/main/native*.ts',
    'src/main/protocol*.ts',
    'src/main/file-save*.ts',
    'src/main/net/**',
    'src/main/platform/**',
    'src/main/startup/**',
    'src/main/app*.ts'
  ]
  const sensitive =
    paths.some((path) =>
      [...criticalDesktopPaths, ...nativeMainPaths].some((pattern) => matchesPath(path, pattern))
    ) ||
    (plan.mode === 'full' && paths.some((path) => path.startsWith('src/main/'))) ||
    paths.some((path) =>
      /^(src\/preload\/|src\/shared\/(ipc|notebook|shell|runtime|window|keyboard|shortcut|sandbox|native)|packages\/(notebook-network-sandbox|process-tree-native|safe-file-publisher-native)\/|patches\/|resources\/|build\/|scripts\/|e2e\/|package(?:-lock)?\.json$|electron|playwright|tsconfig|vitest|vite\.|\.nvmrc$|\.github\/)/.test(
        path
      )
    ) ||
    changes.some(({ status }) =>
      ['deleted', 'renamed', 'type-changed', 'unmerged', 'unknown'].includes(status)
    ) ||
    plan.roots.some((root) => /unknown|unowned|unmatched|bootstrap/.test(root))
  const lanes = new Set(plan.lanes)
  const hasDesktop = plan.bundles.includes('macos_e2e')
  if (hasDesktop && event === 'pull_request') {
    lanes.add('e2e_functional_windows')
    lanes.add('e2e_workspace_windows')
    lanes.add('e2e_browser_windows')
  }
  for (const lane of lanes) {
    if (
      defaultManifest.laneBundles[lane] === 'macos_e2e' ||
      (event === 'merge_group' && defaultManifest.laneBundles[lane] === 'windows_e2e')
    ) {
      lanes.delete(lane)
    }
  }
  if (event === 'merge_group' && hasDesktop) {
    lanes.add('build')
    lanes.add('e2e_smoke_macos')
  }
  const selectedLanes = defaultManifest.laneOrder.filter((lane) => lanes.has(lane))
  const bundles = new Set(selectedLanes.map((lane) => defaultManifest.laneBundles[lane]))
  return {
    ...plan,
    lanes: selectedLanes,
    bundles: defaultManifest.bundleOrder.filter((bundle) => bundles.has(bundle)),
    macosProfile: sensitive ? 'expanded' : 'smoke',
    reasonChains: [
      ...plan.reasonChains,
      event === 'pull_request'
        ? 'pull_request: portable tests and Windows business E2E; Mac validation deferred to merge queue'
        : `merge_group: one Mac core job${sensitive ? ' with native checks' : ''}; complete Mac regression scheduled twice daily`
    ]
  }
}

// Derive groups after module/consumer expansion and event-specific execution selection.
export function macosGroupsForPlan(plan) {
  if (!plan.bundles?.includes('macos_e2e')) return []
  if (
    plan.macosProfile === 'smoke' ||
    (plan.lanes.includes('e2e_smoke_macos') &&
      plan.lanes.every(
        (lane) =>
          defaultManifest.laneBundles[lane] !== 'macos_e2e' ||
          ['build', 'e2e_smoke_macos'].includes(lane)
      ))
  ) {
    return ['journeys']
  }
  if (plan.mode === 'full') return ['journeys', 'presentation', 'regressions', 'delegation']
  const groups = {
    journeys: ['e2e_smoke_macos', 'build', 'e2e_functional_macos', 'e2e_workspace_macos'],
    presentation: ['e2e_accessibility_macos', 'e2e_visual_macos'],
    regressions: ['e2e_regressions_macos'],
    delegation: ['e2e_delegation_macos']
  }
  return Object.entries(groups)
    .filter(([, lanes]) => lanes.some((lane) => plan.lanes.includes(lane)))
    .map(([group]) => group)
}

export function toGitHubOutputPlan(plan) {
  const output = {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    roots: [...plan.roots],
    lanes: [...plan.lanes],
    macosGroups: macosGroupsForPlan(plan)
  }
  if (plan.macosProfile) output.macosProfile = plan.macosProfile
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
