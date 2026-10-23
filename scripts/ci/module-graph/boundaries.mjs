/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'

// Reviewed boundary policy is data, but trusted data: it lives outside the candidate-editable
// registration shards and remains CODEOWNERS-protected. Keep this reader dependency-free so
// trusted preflight can load it without installed packages.
export const boundaryPolicyPath = 'scripts/ci/module-boundaries.json'

const stringList = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
const stringMap = (value, check) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every(check)
const boundaryFields = {
  note: (value) => typeof value === 'string',
  sources: stringList,
  layer: (value) => typeof value === 'string',
  sourceLayers: (value) => stringMap(value, (layer) => typeof layer === 'string'),
  consumerModules: stringList,
  requiredTests: stringList,
  externalImports: stringList,
  resourcePaths: stringList,
  resourceImports: stringList,
  resourceTests: stringList,
  literalLoaders: (value) => value === true,
  pureExternalImports: (value) => stringMap(value, stringList)
}

export function validateBoundaryPolicy(policy) {
  const fail = (message) => {
    throw Error(`Invalid module boundary policy: ${message}`)
  }
  if (
    !policy ||
    policy.schemaVersion !== 1 ||
    Object.keys(policy).some(
      (key) => !['schemaVersion', 'fileLayers', 'publicInterfaceOwners', 'modules'].includes(key)
    )
  )
    fail('unexpected top-level shape')
  if (!stringMap(policy.fileLayers, (layer) => typeof layer === 'string')) fail('fileLayers')
  if (!stringList(policy.publicInterfaceOwners)) fail('publicInterfaceOwners')
  if (!stringMap(policy.modules, (entry) => entry && typeof entry === 'object')) fail('modules')
  for (const [id, boundary] of Object.entries(policy.modules)) {
    for (const [key, value] of Object.entries(boundary))
      if (!boundaryFields[key]?.(value)) fail(`${id}.${key}`)
    if (!boundary.sources || !boundary.consumerModules) fail(`${id} requires sources and consumers`)
  }
  return policy
}

const policy = validateBoundaryPolicy(
  JSON.parse(readFileSync(new URL('../module-boundaries.json', import.meta.url), 'utf8'))
)

export const reviewedBoundaries = policy.modules
export const publicInterfaceOwners = policy.publicInterfaceOwners

// A file's reviewed role: its boundary's per-file override, the boundary layer, then a
// supporting-file entry. Unreviewed files fall back to path conventions in layers.mjs.
export function reviewedFileLayer(path) {
  const boundary = Object.values(reviewedBoundaries).find((entry) => entry.sources.includes(path))
  return boundary?.sourceLayers?.[path] ?? boundary?.layer ?? policy.fileLayers[path]
}

export function usesReviewedBoundary(id, module) {
  const boundary = reviewedBoundaries[id]
  if (!boundary || !module || module.fullTestReason) return false
  const paths = module.ownerPaths.filter((path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path))
  const resources = boundary.resourcePaths ?? []
  const reviewed = [...boundary.sources, ...resources]
  return (
    new Set(reviewed).size === reviewed.length &&
    resources.every((path) => !/\.(?:[cm]?[jt]sx?|json)$/.test(path)) &&
    paths.length === reviewed.length &&
    reviewed.every((path) => paths.includes(path)) &&
    (module.consumerModules ?? []).every((id) => boundary.consumerModules.includes(id))
  )
}
