// Public interface of the module graph: source evidence, the single dependency reader and the
// proofs built on it. Requires the installed TypeScript parser; trusted preflight uses policy.mjs.
export * from './policy.mjs'
export { isSourcePath, sourceSnapshot, workingTreeSource } from './source.mjs'
export { createDependencyReader, isTypeOnlyDependency } from './dependency-reader.mjs'
export {
  checkDerivedConsumerRevisions,
  checkDerivedConsumers,
  checkDerivedConsumersAtRevision,
  checkModuleConsumerCoverage,
  consumerDependencyGraph,
  generateDerivedConsumers,
  runDerivedConsumersCli
} from './derived-consumers.mjs'
export { dependencyBoundaryViolations } from './boundary-evidence.mjs'
export {
  dependencyBasedConsumerRetirements,
  provablyStaleConsumerTests,
  verifiedConsumerRetirements,
  verifiedExcludedPackageTests
} from './retirement.mjs'
export { moduleRelationships } from './relationships.mjs'
