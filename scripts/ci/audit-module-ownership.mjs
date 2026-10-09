/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isModuleOwnershipPath } from './module-ownership-paths.mjs'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'
import { classifyChanges } from './classify-pr-changes.mjs'

export function auditModuleOwnership(manifest, files) {
  const tracked = new Set(files)
  validateModuleImpactManifest(manifest, { pathExists: (path) => tracked.has(path) })
  const owners = new Map()
  for (const [id, module] of Object.entries(manifest.modules)) {
    for (const path of module.ownerPaths) owners.set(path, id)
  }
  const scoped = files.filter(isModuleOwnershipPath)
  const missing = scoped.filter((path) => !owners.has(path))
  const full = scoped.filter((path) => manifest.modules[owners.get(path)]?.fullTestReason)
  const unregisteredResources = files.filter(
    (path) => path.startsWith('resources/') && !owners.has(path)
  )
  return {
    ok: missing.length === 0,
    files: scoped.length,
    owned: scoped.length - missing.length,
    modules: Object.keys(manifest.modules).length,
    missing,
    unregisteredResources,
    full,
    fullModules: Object.entries(manifest.modules)
      .filter(([, module]) => module.fullTestReason)
      .map(([id, module]) => ({ id, reason: module.fullTestReason }))
  }
}

export function auditModuleRouting(manifest) {
  // Audit every registered path, including runtime resources outside the mandatory
  // source inventory. Ownership must not be silently discarded by path routing.
  return Object.entries(manifest.modules)
    .flatMap(([moduleId, module]) => module.ownerPaths.map((path) => [path, moduleId]))
    .flatMap(([path, moduleId]) => {
      const plan = classifyChanges([{ path, status: 'modified' }], undefined, {
        moduleManifest: manifest
      })
      return plan.mode === 'full' && !plan.roots.includes('global_gate_input')
        ? [
            {
              path,
              moduleId,
              reasons: plan.reasonChains.filter((reason) => reason.endsWith('-> full'))
            }
          ]
        : []
    })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8'
      })
        .split('\0')
        .filter((path) => Boolean(path) && existsSync(path))
    )
  ]
  const manifest = loadModuleImpactManifest()
  const result = {
    ...auditModuleOwnership(manifest, files),
    routingGaps: auditModuleRouting(manifest)
  }
  result.ok &&= result.routingGaps.length === 0
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(
      `Module ownership: ${result.owned}/${result.files} files, ${result.modules} modules`
    )
    for (const { id, reason } of result.fullModules)
      console.log(`Intentional full validation: ${id}: ${reason}`)
    for (const path of result.missing) console.error(`Missing owner: ${path}`)
    for (const { path, moduleId } of result.routingGaps)
      console.error(`Registered path falls back to full: ${moduleId}: ${path}`)
    console.log(
      `Unregistered runtime resources (no selective exemption): ${result.unregisteredResources.length}`
    )
  }
  if (!result.ok) process.exitCode = 1
}
