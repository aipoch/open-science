/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  classifyChanges,
  changeImpactManifestPath,
  parseNameStatus
} from './classify-pr-changes.mjs'
import { isModuleOwnershipPath } from './module-ownership-paths.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

const manifestPath = 'scripts/ci/module-impact.json'
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
  const manifestChanged = changed.has(manifestPath)
  const violations = []
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
  if (!baseFiles.includes(manifestPath) && !headFiles.includes(manifestPath)) {
    return { ok: true, violations: [], legacyGaps: [] }
  }
  const headManifest = JSON.parse(git('show', `${head}:${manifestPath}`))
  const baseManifest = baseFiles.includes(manifestPath)
    ? JSON.parse(git('show', `${mergeBase}:${manifestPath}`))
    : headManifest
  return checkModuleOwnership({
    baseManifest,
    headManifest,
    baseFiles,
    headFiles,
    changes: parseNameStatus(git('diff', '--name-status', '-z', mergeBase, head))
  })
}
