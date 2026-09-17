/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import {
  moduleImpactRegistrationPath,
  isModuleImpactRegistrationPath,
  loadModuleImpactManifestAtRevision
} from './load-module-impact.mjs'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import {
  classifyChanges,
  changeImpactManifestPath,
  parseNameStatus
} from './classify-pr-changes.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { isModuleOwnershipPath } from './module-ownership-paths.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

const manifestPath = moduleImpactRegistrationPath
const globalRoots = new Set(
  JSON.parse(readFileSync(changeImpactManifestPath, 'utf8'))
    .rules.filter((rule) => rule.role === 'global' || rule.mode === 'full')
    .map((rule) => rule.id)
)

function covered(path, manifest) {
  const changes = [{ path, status: 'modified' }]
  // Explicit global routing is intentional, not an ownership omission.
  if (classifyChanges(changes).roots.some((root) => globalRoots.has(root))) return true
  return Object.values(manifest.modules).some((module) => module.ownerPaths.includes(path))
}

// Registration is data, but it becomes trusted routing after merge. Retain existing
// evidence so an additive registration cannot quietly weaken later selective runs.
function registrationViolations(baseManifest, headManifest, headFiles) {
  // Compare checked-in routing only; local graph evidence must not mask lost coverage.
  const graph = { status: 'not-used', testFiles: [] }
  const violations = []
  const reject = (field) =>
    violations.push({
      path: manifestPath,
      rule: 'module-registration-regression',
      message: `Registration must preserve ${field}; coverage reductions require a separate CI policy change.`
    })
  const { modules: baseModules, ...baseMetadata } = baseManifest
  const { modules: headModules, ...headMetadata } = headManifest
  if (!isDeepStrictEqual(baseMetadata, headMetadata)) reject('manifest metadata')
  const pathFields = ['ownerPaths', 'interfacePaths']
  const testKinds = ['owner', 'contract', 'consumer']
  const fields = new Set([
    ...pathFields,
    'testFiles',
    'consumerModules',
    'capabilityOverlays',
    'fallbackCapability',
    'fullTestReason'
  ])
  const retain = (before, after, label, applicable = () => true) => {
    if (before.some((entry) => applicable(entry) && !after.includes(entry))) reject(label)
  }
  for (const [id, head] of Object.entries(headModules)) {
    // Do not let unreviewed data introduce a future selector control field.
    for (const key of Object.keys(head)) {
      if (!fields.has(key)) reject(`${id}: unsupported field ${key}`)
    }
    if (
      head.fullTestReason !== undefined &&
      (typeof head.fullTestReason !== 'string' || !head.fullTestReason.trim())
    ) {
      reject(`${id}.fullTestReason`)
    }
  }
  for (const [id, base] of Object.entries(baseModules)) {
    const head = headModules[id]
    if (!head) {
      if (
        [
          ...base.ownerPaths,
          ...base.interfacePaths,
          ...testKinds.flatMap((kind) => base.testFiles[kind])
        ].some((path) => headFiles.has(path))
      ) {
        reject(`${id}: module with surviving paths`)
      }
      continue
    }
    for (const field of pathFields) {
      retain(base[field], head[field], `${id}.${field}`, (path) => headFiles.has(path))
    }
    for (const kind of testKinds) {
      retain(base.testFiles[kind], head.testFiles[kind], `${id}.testFiles.${kind}`, (path) =>
        headFiles.has(path)
      )
    }
    retain(base.consumerModules, head.consumerModules, `${id}.consumerModules`, (consumer) =>
      Object.hasOwn(headModules, consumer)
    )
    retain(base.capabilityOverlays, head.capabilityOverlays, `${id}.capabilityOverlays`)
    if (head.fallbackCapability !== base.fallbackCapability) reject(`${id}.fallbackCapability`)
    if (base.fullTestReason !== undefined && head.fullTestReason !== base.fullTestReason) {
      reject(`${id}.fullTestReason`)
    }
  }
  // The legacy selector infers an implementation owner from its colocated owner
  // test only when no explicit match exists. New explicit entries must not hide it.
  const explicitPaths = (modules) =>
    new Set(
      Object.values(modules).flatMap((module) => [
        ...module.ownerPaths,
        ...module.interfacePaths,
        ...testKinds.flatMap((kind) => module.testFiles[kind])
      ])
    )
  const beforePaths = explicitPaths(baseModules)
  const inferredPaths = new Set(
    Object.values(baseModules).flatMap((module) =>
      module.testFiles.owner.map((path) => path.replace(/\.test(\.[cm]?[jt]sx?)$/, '$1'))
    )
  )
  for (const path of explicitPaths(headModules)) {
    if (beforePaths.has(path) || !inferredPaths.has(path)) continue
    const changes = [{ path, status: 'modified' }]
    const before = createAffectedTestPlan(changes, graph, baseManifest)
    if (before.mode !== 'selective') continue
    const after = createAffectedTestPlan(changes, graph, headManifest)
    if (after.mode === 'full') continue
    retain(before.testFiles, after.testFiles, `${path}: inferred owner tests`, (test) =>
      headFiles.has(test)
    )
    for (const field of ['capabilityOverlays', 'fallbackCapabilities']) {
      retain(before[field], after[field], `${path}: inferred ${field}`)
    }
  }
  return violations
}

export function checkModuleOwnership({
  baseManifest,
  headManifest,
  baseFiles,
  headFiles,
  changes
}) {
  validateModuleImpactManifest(baseManifest)
  const before = new Set(baseFiles)
  const after = new Set(headFiles)
  validateModuleImpactManifest(headManifest, { pathExists: (path) => after.has(path) })
  const changed = new Set(changes.map(({ path }) => path))
  const manifestChanged = changes.some(({ path, previousPath }) =>
    [path, previousPath].filter(Boolean).some(isModuleImpactRegistrationPath)
  )
  const violations = registrationViolations(baseManifest, headManifest, after)
  const legacyGaps = []
  for (const path of headFiles.filter(isModuleOwnershipPath)) {
    if (before.has(path) && !changed.has(path) && !manifestChanged) continue
    if (covered(path, headManifest)) continue
    if (!before.has(path)) {
      violations.push({
        path,
        rule: 'module-ownership-new',
        message: 'Register this new file and its tests/consumers in scripts/ci/module-impact.json.'
      })
    } else if (covered(path, baseManifest)) {
      violations.push({
        path,
        rule: 'module-ownership-regression',
        message: 'Previously covered file lost module ownership; restore its test mapping.'
      })
    } else if (changed.has(path)) {
      legacyGaps.push(path)
    }
  }
  return { ok: violations.length === 0, violations, legacyGaps }
}

export function moduleOwnershipFromRevisions(base, head, { cwd = process.cwd() } = {}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const mergeBase = git('merge-base', base, head).trim()
  const files = (revision) =>
    git('ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean)
  const baseFiles = files(mergeBase)
  const headFiles = files(head)
  // Repositories predating the manifest can bootstrap it; never allow its removal.
  if (
    !baseFiles.some(isModuleImpactRegistrationPath) &&
    !headFiles.some(isModuleImpactRegistrationPath)
  ) {
    return { ok: true, violations: [], legacyGaps: [] }
  }
  const headManifest = loadModuleImpactManifestAtRevision(head, { cwd })
  const baseManifest = baseFiles.some(isModuleImpactRegistrationPath)
    ? loadModuleImpactManifestAtRevision(mergeBase, { cwd })
    : headManifest
  return checkModuleOwnership({
    baseManifest,
    headManifest,
    baseFiles,
    headFiles,
    changes: parseNameStatus(git('diff', '--name-status', '-z', mergeBase, head))
  })
}
