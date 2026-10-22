/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { reviewedFileLayer, publicInterfaceOwners } from './boundaries.mjs'

export function dependencyLayer(path) {
  if (
    /\.(test|spec)\.|\/(?:__tests__|__fixtures__|test-fixtures|test-support|test-utils)\/|(?:^|[/._-])(?:test|spec)[-_.](?:support|fixtures|helpers)/.test(
      path
    )
  )
    return 'test'
  const reviewedLayer = reviewedFileLayer(path)
  if (reviewedLayer) return reviewedLayer
  // Path conventions for files without a reviewed role.
  if (path.startsWith('src/shared/')) return 'shared-contract'
  if (path.startsWith('src/main/composition/')) return 'composition'
  if (path.startsWith('src/renderer/') || path.startsWith('src/preload/')) return 'presentation'
  if (path.startsWith('packages/')) return 'package'
  if (path.startsWith('src/main/ipc-surfaces/')) return 'transport-adapter'
  if (path.startsWith('src/main/')) return 'host-owner'
  return 'resource-or-tooling'
}

// These are enforced seams, not a claim that every legacy owner is fully encapsulated.
export function boundaryViolations(edges, modules) {
  const owners = new Map(
    Object.entries(modules).flatMap(([id, module]) => module.ownerPaths.map((path) => [path, id]))
  )
  const violations = []
  for (const [source, targets] of edges) {
    const layer = dependencyLayer(source)
    if (layer === 'test') continue
    for (const target of targets) {
      const targetLayer = dependencyLayer(target)
      let reason
      if (layer === 'foundation') reason = 'pure foundation must not import another owner'
      else if (
        layer === 'shared-contract' &&
        !['shared-contract', 'foundation', 'package', 'resource-or-tooling'].includes(targetLayer)
      )
        reason = 'shared contracts must not depend on host or presentation implementations'
      else if (
        ['host-owner', 'application-service'].includes(layer) &&
        targetLayer === 'composition'
      )
        reason = 'domain owners must not depend on composition'
      const lower = ['foundation', 'shared-contract', 'package', 'domain-contract']
      const allowed = {
        policy: [...lower, 'policy', 'record-contract', 'resource-or-tooling'],
        'record-contract': [...lower, 'record-contract'],
        'record-codec': [...lower, 'record-contract', 'record-codec', 'policy'],
        'bootstrap-state': [...lower, 'record-contract'],
        'host-adapter': [...lower, 'policy'],
        'domain-contract': [...lower, 'record-contract', 'policy'],
        'host-infrastructure': [
          ...lower,
          'record-contract',
          'policy',
          'host-infrastructure',
          'runtime-state'
        ],
        repository: [
          ...lower,
          'record-contract',
          'record-codec',
          'policy',
          'repository',
          'host-infrastructure',
          'runtime-state'
        ],
        'presentation-model': [...lower, 'presentation-model'],
        'presentation-adapter': [
          ...lower,
          'presentation-model',
          'presentation-adapter',
          'presentation-runtime',
          'presentation'
        ],
        'presentation-runtime': [
          ...lower,
          'presentation-model',
          'presentation-runtime',
          'presentation'
        ]
      }[layer]
      if (allowed && !allowed.includes(targetLayer))
        reason = `${layer} must not depend on ${targetLayer}`
      if (
        ['application-service', 'runtime-state', 'command-adapter'].includes(layer) &&
        [
          'presentation',
          'presentation-model',
          'presentation-adapter',
          'presentation-runtime',
          'composition'
        ].includes(targetLayer)
      )
        reason = `${layer} must not depend on ${targetLayer}`
      if (layer === 'application-service' && targetLayer === 'command-adapter')
        reason = 'application services must not depend on command adapters'
      const targetOwner = owners.get(target)
      if (
        publicInterfaceOwners.includes(targetOwner) &&
        owners.get(source) !== targetOwner &&
        !modules[targetOwner].interfacePaths.includes(target)
      )
        reason = 'cross-owner dependency must use the public interface'
      if (reason) violations.push(`${source} -> ${target}: ${reason}`)
    }
  }
  return violations.sort()
}
