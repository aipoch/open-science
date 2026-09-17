/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isModuleOwnershipPath } from './module-ownership-paths.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

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
  return {
    ok: missing.length === 0,
    files: scoped.length,
    owned: scoped.length - missing.length,
    modules: Object.keys(manifest.modules).length,
    missing,
    full,
    fullModules: Object.entries(manifest.modules)
      .filter(([, module]) => module.fullTestReason)
      .map(([id, module]) => ({ id, reason: module.fullTestReason }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const manifest = JSON.parse(
    readFileSync(new URL('./module-impact.json', import.meta.url), 'utf8')
  )
  const result = auditModuleOwnership(manifest, files)
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(
      `Module ownership: ${result.owned}/${result.files} files, ${result.modules} modules`
    )
    for (const { id, reason } of result.fullModules)
      console.log(`Intentional full validation: ${id}: ${reason}`)
    for (const path of result.missing) console.error(`Missing owner: ${path}`)
  }
  if (!result.ok) process.exitCode = 1
}
