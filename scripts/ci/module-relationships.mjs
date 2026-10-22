/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceSnapshot, createConsumerDependencyReader } from './consumer-retirement.mjs'
import { loadModuleImpactManifestAtRevision } from './load-module-impact.mjs'

import { dependencyLayer, usesDependencyConsumers } from './module-derived-consumers.mjs'
export { dependencyLayer, boundaryViolations } from './module-derived-consumers.mjs'

export function moduleRelationships(revision = 'HEAD', cwd = process.cwd()) {
  const sha = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
    { cwd, encoding: 'utf8' }
  ).trim()
  const source = sourceSnapshot(sha, cwd)
  const manifest = loadModuleImpactManifestAtRevision(sha, { cwd })
  const owners = new Map(
    Object.entries(manifest.modules).flatMap(([id, module]) =>
      module.ownerPaths.map((path) => [path, id])
    )
  )
  const structural = createConsumerDependencyReader(source, [])
  const runtime = createConsumerDependencyReader(source, [], { runtimeOnly: true })
  const relations = new Map()
  const add = (kind, from, to, sourcePath, targetPath) => {
    if (!from || !to || from === to) return
    const key = `${kind}:${from}:${to}`
    if (!relations.has(key)) relations.set(key, { kind, from, to, paths: [] })
    if (sourcePath) relations.get(key).paths.push([sourcePath, targetPath])
  }
  const files = [...source.files].filter(
    (path) =>
      /^(src|packages)\//.test(path) &&
      /\.[cm]?[jt]sx?$/.test(path) &&
      dependencyLayer(path) !== 'test'
  )
  for (const path of files) {
    const values = runtime.dependencies(path).paths
    for (const target of structural.dependencies(path).paths)
      add(
        values.has(target) ? 'runtime-import' : 'type-import',
        owners.get(path),
        owners.get(target),
        path,
        target
      )
  }
  for (const [target, consumers] of Object.entries(
    JSON.parse(source.read('scripts/ci/module-runtime-consumers.json'))
  ))
    for (const consumer of consumers)
      add('dynamic-contract', owners.get(consumer), owners.get(target), consumer, target)
  for (const [id, module] of Object.entries(manifest.modules))
    for (const consumer of module.consumerModules)
      add(usesDependencyConsumers(id, module) ? 'capability-routing' : 'test-routing', id, consumer)
  return {
    revision: sha,
    directions: {
      'runtime-import': 'consumer -> dependency',
      'type-import': 'consumer -> dependency',
      'dynamic-contract': 'consumer -> dependency',
      'test-routing': 'changed owner -> consumer evidence',
      'capability-routing': 'changed owner -> platform/fallback obligations only'
    },
    note: 'Layers describe file roles, not complete domain encapsulation. Runtime schemas are values. Missing/opaque dependencies are not proof of independence; edges do not represent observed execution.',
    modules: Object.entries(manifest.modules).map(([id, module]) => ({
      id,
      layers: [
        ...new Set(
          module.ownerPaths.filter((path) => dependencyLayer(path) !== 'test').map(dependencyLayer)
        )
      ].sort(),
      ownerPaths: module.ownerPaths,
      interfacePaths: module.interfacePaths,
      tests: Object.fromEntries(
        Object.entries(module.testFiles).map(([kind, files]) => [kind, files.length])
      ),
      fullTestReason: module.fullTestReason,
      capabilityOverlays: module.capabilityOverlays,
      unresolvedRuntimeFiles: module.ownerPaths.filter(
        (path) => files.includes(path) && !runtime.dependencies(path).complete
      )
    })),
    relations: [...relations.values()].sort((a, b) =>
      `${a.kind}:${a.from}:${a.to}`.localeCompare(`${b.kind}:${b.from}:${b.to}`)
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(
    JSON.stringify(moduleRelationships(process.argv[2] ?? 'HEAD'), null, 2) + '\n'
  )
