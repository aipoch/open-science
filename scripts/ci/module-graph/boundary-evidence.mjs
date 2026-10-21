/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { reviewedBoundaries, usesReviewedBoundary } from './boundaries.mjs'
import { createDependencyReader } from './dependency-reader.mjs'
import { boundaryViolations } from './layers.mjs'

// This is an explicit dependency-model policy, NOT a proof that opaque consumer cones are
// independent. Only reviewed source boundaries may trade inherited history for known edges.
export function dependencyBoundaryViolations(
  source,
  manifest,
  baseManifest = manifest,
  runtimeEdges
) {
  let edges, strict, inspect
  try {
    edges =
      runtimeEdges ??
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json') ?? '{}'))
    strict = createDependencyReader(source, edges, {
      staticOnly: true,
      runtimeOnly: true
    })
    inspect = createDependencyReader(source, edges)
  } catch (error) {
    return [
      {
        path: 'scripts/ci/module-impact.json',
        rule: 'dependency-consumer-boundary',
        message: `Cannot validate dependency evidence: ${error.message}`
      }
    ]
  }
  const violations = []
  // Inspect structural edges too: erased type imports must not reverse a layer.
  const structuralEdges = new Map()
  const pending = Object.entries(reviewedBoundaries).flatMap(([id, boundary]) =>
    manifest.modules[id] && !manifest.modules[id].fullTestReason ? boundary.sources : []
  )
  while (pending.length) {
    const path = pending.pop()
    if (structuralEdges.has(path) || !source.files.has(path)) continue
    const targets = inspect.dependencies(path).paths
    structuralEdges.set(path, targets)
    pending.push(...targets)
  }
  for (const message of boundaryViolations(structuralEdges, manifest.modules))
    violations.push({
      path: 'scripts/ci/module-impact.json',
      rule: 'dependency-consumer-boundary',
      message
    })
  for (const [id, boundary] of Object.entries(reviewedBoundaries)) {
    const module = manifest.modules[id]
    if (!module || module.fullTestReason) continue
    const reject = (message) =>
      violations.push({
        path: `scripts/ci/module-impact/${id}.json`,
        rule: 'dependency-consumer-boundary',
        message
      })
    const directRuntime = createDependencyReader(source, edges, {
      runtimeOnly: true,
      externalImports: boundary.externalImports,
      literalLoaders: boundary.literalLoaders,
      resourceImports: boundary.resourceImports,
      reviewedSyntax: true
    })
    const directCodec = createDependencyReader(source, edges, {
      runtimeOnly: true,
      staticOnly: true,
      reviewedSyntax: true,
      externalImports: boundary.externalImports
    })
    // Low-level files in a mixed owner cannot borrow its filesystem/process permissions.
    const policyReaders = new Map()
    const directPolicy = (path) => {
      const imports = boundary.pureExternalImports?.[path] ?? []
      const key = JSON.stringify(imports)
      if (!policyReaders.has(key))
        policyReaders.set(
          key,
          createDependencyReader(source, edges, {
            runtimeOnly: true,
            staticOnly: true,
            strictExternalImports: true,
            reviewedSyntax: true,
            externalImports: [
              'zod',
              'node:buffer',
              'node:path',
              'node:url',
              'node:util',
              ...imports
            ]
          })
        )
      return policyReaders.get(key)
    }

    const layerOf = (path) => boundary.sourceLayers?.[path] ?? boundary.layer
    const readerFor = (path) =>
      ['policy', 'domain-contract', 'presentation-model'].includes(layerOf(path))
        ? directPolicy(path)
        : ['record-codec', 'record-contract', 'bootstrap-state'].includes(layerOf(path))
          ? directCodec
          : directRuntime
    const evidence = Object.values(module.testFiles).flat()
    const resources = [...(boundary.resourcePaths ?? []), ...(boundary.resourceImports ?? [])]
    const missingResource = resources.find((path) => !source.files.has(path))
    // Each condition names the reviewed fact it protects, so a rejection is actionable.
    const unmet = [
      !usesReviewedBoundary(id, module) &&
        'owner paths or consumer modules no longer match the reviewed sources',
      // Resource inputs keep exact ownership and explicit behavior/packaging tests. A new
      // asset or fixture cannot silently inherit approval from a directory-wide pattern.
      missingResource && `missing reviewed resource ${missingResource}`,
      resources.length > 0 &&
        (!boundary.resourceTests?.length ||
          boundary.resourceTests.some((test) => !boundary.requiredTests?.includes(test))) &&
        'resource inputs require resourceTests that are also requiredTests',
      Object.entries(boundary.pureExternalImports ?? {}).some(
        ([path, imports]) =>
          !boundary.sources.includes(path) ||
          !Array.isArray(imports) ||
          imports.some(
            (specifier) =>
              !['clsx', 'tailwind-merge', 'diff', 'marked', 'parse5'].includes(specifier)
          )
      ) && 'pureExternalImports must name reviewed sources and allowlisted packages',
      ...boundary.sources.map(
        (path) =>
          !(boundary.externalImports
            ? readerFor(path).dependencies(path).complete
            : strict(path, new Set()).complete) &&
          `incomplete dependency evidence in ${path} (${layerOf(path)})`
      ),
      ...(boundary.requiredTests ?? []).map(
        (test) =>
          (source.read(test) === undefined || !evidence.includes(test)) &&
          `required test ${test} is missing or unregistered`
      )
    ].filter(Boolean)
    if (unmet.length) {
      reject(
        `${id}: source-derived selection requires its reviewed sources, runtime imports and behavioral contracts; restore it or register fullTestReason for reclassification (${unmet.join('; ')}).`
      )
      continue
    }
    const original = baseManifest.modules[id]
    const owners = new Set(module.ownerPaths)
    for (const test of module.testFiles.consumer) {
      if (original?.testFiles.consumer.includes(test)) continue
      if (!inspect(test, owners).reachable)
        reject(
          `${id}: ${test} has no known dependency; register an explicit behavioral contract or runtime edge instead of inherited consumers.`
        )
    }
  }
  return violations
}
