/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import {
  loadModuleImpactManifest,
  loadModuleImpactManifestAtRevision
} from './load-module-impact.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

import {
  derivedConsumersPath,
  loadDerivedConsumers,
  validateDerivedConsumers,
  withDerivedConsumers
} from './module-graph/policy.mjs'

const defaultManifest = loadModuleImpactManifest()
const shard = /^scripts\/ci\/module-impact\/([a-z][a-z0-9_]*)\.json$/
const testKinds = ['owner', 'contract', 'consumer']

// Candidate JSON may add evidence to an existing trusted owner, never replace its
// policy. Global input changes still force full in the ordinary path classifier.
export function additiveModuleImpact(base, head, trusted, baseFiles, headFiles) {
  validateModuleImpactManifest(base)
  validateModuleImpactManifest(head, { pathExists: (path) => headFiles.has(path) })
  const { modules: before, ...baseMetadata } = base
  const { modules: after, ...headMetadata } = head
  if (
    !isDeepStrictEqual(baseMetadata, headMetadata) ||
    !isDeepStrictEqual(Object.keys(before).sort(), Object.keys(after).sort())
  )
    return null
  const resolved = structuredClone(trusted)
  const append = (oldPaths, newPaths, target, owners = false) => {
    if (oldPaths.some((path) => !newPaths.includes(path))) return false
    const additions = newPaths.filter((path) => !oldPaths.includes(path))
    // Reassigning an existing path could hide inferred ownership or test evidence.
    if (owners && additions.some((path) => baseFiles.has(path))) return false
    target.push(...additions.filter((path) => !target.includes(path)))
    return true
  }
  for (const [id, original] of Object.entries(before)) {
    const candidate = after[id]
    if (isDeepStrictEqual(original, candidate)) continue
    const target = resolved.modules[id]
    if (!target) return null
    const { ownerPaths, interfacePaths, testFiles, ...policy } = original
    const {
      ownerPaths: nextOwners,
      interfacePaths: nextInterfaces,
      testFiles: nextTests,
      ...nextPolicy
    } = candidate
    if (!isDeepStrictEqual(policy, nextPolicy)) return null
    if (
      !append(ownerPaths, nextOwners, target.ownerPaths, true) ||
      !append(interfacePaths, nextInterfaces, target.interfacePaths)
    )
      return null
    for (const kind of testKinds) {
      if (!append(testFiles[kind], nextTests[kind], target.testFiles[kind])) return null
    }
  }
  validateModuleImpactManifest(resolved)
  return resolved
}

function resolveExplicitModuleImpactInputs(
  changes,
  { base, head, cwd = process.cwd(), execute = execFileSync, manifest = defaultManifest } = {}
) {
  const fallback = { manifest, registrationModules: [] }
  const records = changes.filter(({ path }) => shard.test(path))
  if (!records.length) return fallback
  try {
    const git = (...args) =>
      execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).toString()
    const mergeBase = git('merge-base', base, head).trim()
    const files = (revision) =>
      new Set(git('ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean))
    const before = loadModuleImpactManifestAtRevision(mergeBase, { cwd })
    const after = loadModuleImpactManifestAtRevision(head, { cwd })
    // A data-only revision cannot change application behavior. Integrity still proves
    // preservation; this route runs the policy and manifest-reading contract suites.
    const actualPaths = git('diff', '--name-only', '-z', mergeBase, head)
      .split('\0')
      .filter(Boolean)
    if (
      changes.length === records.length &&
      records.every(({ status }) => ['added', 'modified', 'deleted'].includes(status)) &&
      actualPaths.length > 0 &&
      actualPaths.every((path) => shard.test(path))
    ) {
      validateModuleImpactManifest(before)
      const headFiles = files(head)
      validateModuleImpactManifest(after, { pathExists: (path) => headFiles.has(path) })
      return { ...fallback, registrationOnly: true }
    }
    if (records.some(({ status }) => status !== 'modified')) return fallback
    const resolved = additiveModuleImpact(before, after, manifest, files(mergeBase), files(head))
    if (!resolved) return fallback
    const registrationModules = records.map(({ path }) => shard.exec(path)[1])
    if (registrationModules.some((id) => !resolved.modules[id])) return fallback
    return { manifest: resolved, registrationModules }
  } catch {
    // Invalid, missing, ambiguous or incompatible data retains the global fallback.
    // CI Integrity independently reports the registration error and blocks admission.
    return fallback
  }
}

// A regenerated derived index is evidence, not policy: merge the candidate's tests into the
// trusted index so selection can only grow. CI Integrity independently proves it matches source.
function additiveDerivedIndex(trusted, change, { head, cwd, execute, manifest }) {
  if (change.status !== 'modified' || change.previousPath || !trusted) return null
  try {
    const git = (...args) =>
      execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).toString()
    const headManifest = loadModuleImpactManifestAtRevision(head, { cwd })
    const candidate = validateDerivedConsumers(
      JSON.parse(git('show', `${head}:${derivedConsumersPath}`)),
      headManifest
    )
    const headFiles = new Set(
      git('ls-tree', '-r', '--name-only', '-z', head).split('\0').filter(Boolean)
    )
    for (const id of Object.keys(candidate.modules)) if (!manifest.modules[id]) return null
    // Evidence only grows, but a test the head revision deleted cannot be selected from either side.
    const modules = {}
    for (const id of new Set([
      ...Object.keys(trusted.modules),
      ...Object.keys(candidate.modules)
    ])) {
      const tests = [...(trusted.modules[id] ?? []), ...(candidate.modules[id] ?? [])].filter(
        (test) => headFiles.has(test)
      )
      if (tests.length) modules[id] = [...new Set(tests)].sort()
    }
    return validateDerivedConsumers({ schemaVersion: 1, modules }, manifest)
  } catch {
    return null
  }
}

// Explicit registration proofs always inspect raw manifests, then add derived evidence for execution.
// The returned changes omit an accepted derived index so it no longer routes as a global input.
export function resolveModuleImpactInputs(changes, options = {}) {
  const indexChange = changes.find(({ path }) => path === derivedConsumersPath)
  const remaining = changes.filter((change) => change !== indexChange)
  const result = resolveExplicitModuleImpactInputs(indexChange ? remaining : changes, options)
  const trusted =
    options.derivedConsumers ?? (options.manifest ? undefined : loadDerivedConsumers())
  const merged =
    indexChange && options.base && options.head
      ? additiveDerivedIndex(trusted, indexChange, {
          cwd: process.cwd(),
          execute: execFileSync,
          ...options,
          manifest: result.manifest
        })
      : null
  if (indexChange && !merged) return { ...result, changes }
  const index = merged ?? trusted
  return {
    ...result,
    changes: merged ? remaining : changes,
    ...(merged && { derivedIndexAccepted: true }),
    manifest: index ? withDerivedConsumers(result.manifest, index) : result.manifest
  }
}
