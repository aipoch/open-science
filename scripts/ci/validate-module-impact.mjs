/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const defaultManifest = JSON.parse(
  readFileSync(new URL('./module-impact.json', import.meta.url), 'utf8')
)
const changeImpactManifest = JSON.parse(
  readFileSync(new URL('./change-impact.json', import.meta.url), 'utf8')
)
const defaultCapabilities = new Set(Object.keys(changeImpactManifest.capabilities))
const moduleTestKinds = ['owner', 'contract', 'consumer']

function requireStringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  if (nonEmpty && value.length === 0) throw new Error(`${label} must not be empty`)
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicate entries`)
  return value
}

function validateRepositoryPath(path, label, pathExists) {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('//') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a portable repository-relative path: ${path}`)
  }
  if (pathExists && !pathExists(path)) throw new Error(`${label} does not exist: ${path}`)
}

export function validateModuleImpactManifest(
  manifest = defaultManifest,
  { pathExists, knownCapabilities = defaultCapabilities } = {}
) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error('Module-impact manifest schemaVersion must be 1')
  }
  if (
    !manifest.modules ||
    typeof manifest.modules !== 'object' ||
    Array.isArray(manifest.modules) ||
    Object.keys(manifest.modules).length === 0
  ) {
    throw new Error('Module-impact manifest must declare modules')
  }

  const modules = manifest.modules
  const moduleIds = new Set(Object.keys(modules))
  const ownedPaths = new Map()

  for (const [moduleId, module] of Object.entries(modules)) {
    if (!/^[a-z][a-z0-9_]*$/.test(moduleId)) {
      throw new Error(`Invalid module-impact module id: ${moduleId}`)
    }

    const ownerPaths = requireStringArray(module.ownerPaths, `${moduleId}.ownerPaths`, {
      nonEmpty: true
    })
    const interfacePaths = requireStringArray(module.interfacePaths, `${moduleId}.interfacePaths`, {
      nonEmpty: true
    })
    const consumers = requireStringArray(module.consumerModules, `${moduleId}.consumerModules`)
    const overlays = requireStringArray(module.capabilityOverlays, `${moduleId}.capabilityOverlays`)

    for (const ownerPath of ownerPaths) {
      validateRepositoryPath(ownerPath, `${moduleId}.ownerPaths`, pathExists)
      const existingOwner = ownedPaths.get(ownerPath)
      if (existingOwner) {
        throw new Error(
          `Module owner path ${ownerPath} is shared by ${existingOwner} and ${moduleId}`
        )
      }
      ownedPaths.set(ownerPath, moduleId)
    }
    for (const interfacePath of interfacePaths) {
      validateRepositoryPath(interfacePath, `${moduleId}.interfacePaths`, pathExists)
    }

    for (const consumer of consumers) {
      if (!moduleIds.has(consumer)) {
        throw new Error(`Unknown consumer module for ${moduleId}: ${consumer}`)
      }
      if (consumer === moduleId) throw new Error(`Module ${moduleId} cannot consume itself`)
    }
    for (const overlay of overlays) {
      if (!knownCapabilities.has(overlay)) {
        throw new Error(`Unknown capability overlay for ${moduleId}: ${overlay}`)
      }
    }
    if (!knownCapabilities.has(module.fallbackCapability)) {
      throw new Error(
        `Unknown fallback capability for ${moduleId}: ${String(module.fallbackCapability)}`
      )
    }

    if (
      !module.testFiles ||
      typeof module.testFiles !== 'object' ||
      Array.isArray(module.testFiles)
    ) {
      throw new Error(`${moduleId}.testFiles must declare owner, contract, and consumer tests`)
    }
    const unexpectedTestKinds = Object.keys(module.testFiles).filter(
      (kind) => !moduleTestKinds.includes(kind)
    )
    if (unexpectedTestKinds.length > 0) {
      throw new Error(`${moduleId}.testFiles has unknown kinds: ${unexpectedTestKinds.join(', ')}`)
    }
    const declaredTests = []
    const classifiedTests = new Set()
    for (const kind of moduleTestKinds) {
      const tests = requireStringArray(module.testFiles[kind], `${moduleId}.testFiles.${kind}`)
      for (const testFile of tests) {
        if (classifiedTests.has(testFile)) {
          throw new Error(`${moduleId}.testFiles classifies ${testFile} more than once`)
        }
        classifiedTests.add(testFile)
        declaredTests.push(testFile)
      }
    }
    if (declaredTests.length === 0) throw new Error(`${moduleId}.testFiles must not be empty`)
    for (const testFile of declaredTests) {
      validateRepositoryPath(testFile, `${moduleId}.testFiles`, pathExists)
      if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(testFile)) {
        throw new Error(`${moduleId}.testFiles must reference a test file: ${testFile}`)
      }
    }
  }

  const visited = new Set()
  const visitConsumers = (moduleId, path, visiting) => {
    if (visiting.has(moduleId)) {
      throw new Error(`Module-impact consumer cycle: ${[...path, moduleId].join(' -> ')}`)
    }
    if (visited.has(moduleId)) return

    const nextVisiting = new Set(visiting).add(moduleId)
    const nextPath = [...path, moduleId]
    for (const consumer of modules[moduleId].consumerModules) {
      visitConsumers(consumer, nextPath, nextVisiting)
    }
    visited.add(moduleId)
  }
  for (const moduleId of moduleIds) visitConsumers(moduleId, [], new Set())

  return manifest
}

export const moduleImpactManifestPath = fileURLToPath(
  new URL('./module-impact.json', import.meta.url)
)
