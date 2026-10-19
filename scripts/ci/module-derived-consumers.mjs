/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { lstatSync, readFileSync } from 'node:fs'

export const derivedConsumersPath = 'scripts/ci/module-derived-consumers.json'

// Keep this reader dependency-free: trusted preflight has no installed parser/runtime.
export function validateDerivedConsumers(index, manifest) {
  if (
    !index ||
    index.schemaVersion !== 1 ||
    Object.keys(index).some((key) => !['schemaVersion', 'modules'].includes(key)) ||
    !index.modules ||
    typeof index.modules !== 'object' ||
    Array.isArray(index.modules)
  )
    throw Error('Invalid derived consumer index')
  for (const [id, tests] of Object.entries(index.modules)) {
    if (!Object.hasOwn(manifest.modules, id)) throw Error(`Unknown derived consumer module: ${id}`)
    if (!Array.isArray(tests) || new Set(tests).size !== tests.length)
      throw Error(`Invalid derived consumer tests: ${id}`)
    for (const path of tests) {
      if (
        typeof path !== 'string' ||
        path.startsWith('/') ||
        path.includes('\\') ||
        /^[A-Za-z]:/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        path.startsWith('e2e/') ||
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
      )
        throw Error(`Invalid derived consumer test path: ${id} -> ${path}`)
    }
  }
  return index
}

export function loadDerivedConsumers(
  path = new URL('./module-derived-consumers.json', import.meta.url)
) {
  if (!lstatSync(path).isFile()) throw Error('Derived consumer index must be a regular file')
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Never use the effective manifest for explicit-contract retirement/ownership proofs.
export function withDerivedConsumers(manifest, index) {
  validateDerivedConsumers(index, manifest)
  const effective = structuredClone(manifest)
  for (const [id, tests] of Object.entries(index.modules)) {
    const module = effective.modules[id]
    const declared = new Set(Object.values(module.testFiles).flat())
    const additions = tests.filter((path) => !declared.has(path)).sort()
    if (!additions.length) continue
    module.testFiles.consumer.push(...additions)
    module.derivedConsumerTests = additions
  }
  return effective
}
