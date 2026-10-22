// Dependency-free facade for trusted preflight (no installed packages are available there).
// Consumers outside module-graph/ import this file or index.mjs, never the internals.
export {
  boundaryPolicyPath,
  publicInterfaceOwners,
  reviewedBoundaries,
  reviewedFileLayer,
  usesReviewedBoundary,
  validateBoundaryPolicy
} from './boundaries.mjs'
export {
  derivedConsumersPath,
  loadDerivedConsumers,
  validateDerivedConsumers,
  withDerivedConsumers
} from './derived-index.mjs'
export { boundaryViolations, dependencyLayer } from './layers.mjs'
