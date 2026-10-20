/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  checkDerivedConsumers,
  workingConsumerSource
} from './generate-module-derived-consumers.mjs'
import { loadDerivedConsumers, withDerivedConsumers } from './module-derived-consumers.mjs'
import assert from 'node:assert/strict'
import { loadModuleImpactManifest } from './load-module-impact.mjs'

// This guard supplements the explicit IPC/behavioral contracts in the manifest. It does not
// claim that imports can discover event dispatch, filesystem protocols or dynamic strings.
export function checkModuleConsumerCoverage() {
  const source = workingConsumerSource()
  const manifest = loadModuleImpactManifest()
  const { reverse } = checkDerivedConsumers(source, manifest)
  const { modules } = withDerivedConsumers(manifest, loadDerivedConsumers())
  const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('e2e/')
  for (const [path, consumers] of reverse) {
    if (!isTest(path) || consumers.size === 0 || !/^(src|packages)\//.test(path)) continue
    assert.ok(
      Object.values(modules).some(
        (module) => module.ownerPaths.includes(path) && module.interfacePaths.includes(path)
      ),
      `${path} exports shared test contracts; register it as an interface to retain consumers`
    )
  }
  const missing = []
  for (const [id, module] of Object.entries(modules)) {
    if (module.fullTestReason || id === 'i18n_catalog') continue
    const visited = new Set(
      module.ownerPaths.filter((path) => !isTest(path) || module.interfacePaths.includes(path))
    )
    const pending = [...visited]
    while (pending.length) {
      for (const consumer of reverse.get(pending.pop()) ?? []) {
        if (visited.has(consumer)) continue
        visited.add(consumer)
        pending.push(consumer)
      }
    }
    // Require complete coverage, not minimal coverage. Only trusted base/head evidence can
    // authorize retirement; current independence alone cannot remove historical host contracts.
    const declared = new Set(Object.values(module.testFiles).flat())
    for (const path of visited)
      if (isTest(path) && !declared.has(path)) missing.push(`${id} -> ${path}`)
  }
  assert.deepEqual(missing, [], 'Regenerate derived consumers or add explicit behavioral contracts')
}
