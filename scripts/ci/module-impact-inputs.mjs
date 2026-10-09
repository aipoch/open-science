/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import {
  loadModuleImpactManifest,
  loadModuleImpactManifestAtRevision
} from './load-module-impact.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

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

export function resolveModuleImpactInputs(
  changes,
  { base, head, cwd = process.cwd(), execute = execFileSync, manifest = defaultManifest } = {}
) {
  const fallback = { manifest, registrationModules: [] }
  const records = changes.filter(({ path }) => shard.test(path))
  if (!records.length || records.some(({ status }) => status !== 'modified')) return fallback
  try {
    const git = (...args) =>
      execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).toString()
    const mergeBase = git('merge-base', base, head).trim()
    const files = (revision) =>
      new Set(git('ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean))
    const resolved = additiveModuleImpact(
      loadModuleImpactManifestAtRevision(mergeBase, { cwd }),
      loadModuleImpactManifestAtRevision(head, { cwd }),
      manifest,
      files(mergeBase),
      files(head)
    )
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
