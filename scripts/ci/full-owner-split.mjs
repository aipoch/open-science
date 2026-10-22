/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { classifyChanges, fixtureTestPatterns } from './classify-pr-changes.mjs'
import { isModuleImpactRegistrationPath } from './load-module-impact.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { createPackageTestPlan } from './package-test-impact.mjs'
import {
  consumerDependencyGraph,
  createDependencyReader,
  derivedConsumersPath,
  generateDerivedConsumers,
  sourceSnapshot,
  withDerivedConsumers
} from './module-graph/index.mjs'

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
const sharedSource = (path) => /^src\/shared\/.*\.[cm]?[jt]sx?$/.test(path)
// The renderer catalog and its generated map are addressed by method name, not by import.
const catalogSurface = (path) =>
  /^src\/shared\/(?:renderer-contract-catalog|renderer-contract|web-rpc-contract|web-api-map\.generated)\.ts$/.test(
    path
  ) || path.startsWith('src/shared/renderer-contracts/')
const contains = (after, before) => before.every((entry) => after.includes(entry))
const evidence = (module) => Object.values(module.testFiles).flat()
const runtimeOptions = {
  staticOnly: true,
  runtimeOnly: true,
  strictExternalImports: true,
  externalImports: ['zod', 'node:buffer', 'node:path', 'node:url', 'node:util']
}

const eventApis = new Set([
  'on',
  'once',
  'off',
  'emit',
  'send',
  'invoke',
  'handle',
  'handleOnce',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent'
])
const isStringLike = (node) =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateExpression(node)

// Channel/event names and persisted-format markers bind consumers by value, not by import.
function dynamicMarkers(text, path) {
  const markers = []
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  // Local constants let `emit(NAME)` resolve to the literal it dispatches.
  const constants = new Map()
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      if (isStringLike(node.initializer)) constants.set(node.name.text, node.initializer)
    ts.forEachChild(node, collect)
  }
  ts.forEachChild(ast, collect)
  const visit = (node) => {
    const specifier =
      (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
      node.parent.moduleSpecifier === node
    if (!specifier) {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*/.test(node.text)
      )
        markers.push(`name literal ${node.text}`)
      // A segment that is only a name next to the interpolation is a channel: `domain:${id}`,
      // `${id}:open`, `a:${x}:b`. Prose such as `Error: ${x}` or `https://host/${x}` is not.
      if (
        (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
        /^(?:[a-z][a-z0-9-]*:|:[a-z][a-z0-9-]*:?)$/.test(node.text)
      )
        markers.push(`name template ${node.text}`)
    }
    // Any name passed to an event/IPC API is bound by value, whatever its shape: `bus.emit`,
    // `bus['emit']`, a destructured `emit` and `new FooEvent` / `new dom.FooEvent` all count.
    const method = (callee) =>
      ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined
    const dispatch =
      (ts.isCallExpression(node) && eventApis.has(method(node.expression))) ||
      (ts.isNewExpression(node) && /Event$/.test(method(node.expression) ?? ''))
    const [name] = dispatch ? (node.arguments ?? []) : []
    const target = name && ts.isIdentifier(name) ? constants.get(name.text) : name
    if (target && isStringLike(target)) markers.push(`event name ${target.getText()}`)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(ast, visit)
  if (/\b(?:schemaVersion|SCHEMA_VERSION|FORMAT_VERSION|localStorage|sessionStorage)\b/.test(text))
    markers.push('persisted-format marker')
  return markers
}

// A full owner may hand cohesive static contracts to new modules, and regression data to the
// existing reader owners, only in a registration-only revision. Dynamic surfaces stay full.
export function verifiedFullOwnerSplits(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  const empty = () => ({ paths: new Set(), ownerTests: new Set(), rewordedOwners: new Set() })
  try {
    const owner = (manifest, path) =>
      Object.entries(manifest.modules).filter(([, module]) => module.ownerPaths.includes(path))
    const transfers = []
    for (const [id, original] of Object.entries(baseManifest.modules)) {
      const remaining = headManifest.modules[id]
      if (!original.fullTestReason || !remaining) continue
      const lost = original.ownerPaths.filter((path) => !remaining.ownerPaths.includes(path))
      if (!lost.length) continue
      transfers.push({ id, original, remaining, lost })
    }
    if (!transfers.length) return empty()
    // Registration data and the independently recomputed derived index only.
    const changed = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
      cwd
    })
      .toString()
      .split('\0')
      .filter(Boolean)
    if (
      changed.some((path) => !isModuleImpactRegistrationPath(path) && path !== derivedConsumersPath)
    )
      return empty()
    const before = sourceSnapshot(base, cwd)
    const after = sourceSnapshot(head, cwd)
    const runtime = [before, after].map((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json') ?? '{}'))
    )
    const edges = runtime.flat()
    const runtimePaths = new Set(edges.flatMap(([target, consumers]) => [target, ...consumers]))
    const graphs = [before, after].map((source, index) =>
      consumerDependencyGraph(source, runtime[index])
    )
    const effective = withDerivedConsumers(
      headManifest,
      generateDerivedConsumers(headManifest, graphs[1].reverse)
    )
    const baseEffective = withDerivedConsumers(
      baseManifest,
      generateDerivedConsumers(baseManifest, graphs[0].reverse)
    )
    const registry = JSON.parse(before.read('scripts/ci/package-test-boundaries.json') ?? 'null')
    const strict = createDependencyReader(after, edges, runtimeOptions)
    const reached = (starts, { tests = true } = {}) => {
      const visited = new Set()
      for (const { reverse } of graphs) {
        const pending = [...starts]
        while (pending.length) {
          for (const path of reverse.get(pending.pop()) ?? []) {
            if (visited.has(path)) continue
            visited.add(path)
            pending.push(path)
          }
        }
      }
      return [...visited].filter((path) => !tests || (isTest(path) && !path.startsWith('e2e/')))
    }
    const plan = (path, manifest) =>
      createAffectedTestPlan(
        [{ path, status: 'modified' }],
        { status: 'not-used', testFiles: [] },
        manifest
      )
    const result = empty()
    for (const { id, original, remaining, lost } of transfers) {
      // The remaining owner keeps every historical bucket, edge and routing obligation.
      if (
        !remaining.fullTestReason ||
        remaining.fallbackCapability !== original.fallbackCapability ||
        !contains(remaining.capabilityOverlays, original.capabilityOverlays) ||
        !contains(remaining.consumerModules, original.consumerModules) ||
        !['contract', 'consumer'].every((kind) =>
          contains(remaining.testFiles[kind], original.testFiles[kind])
        ) ||
        !contains(
          remaining.testFiles.owner,
          original.testFiles.owner.filter((test) => !lost.includes(test))
        ) ||
        !contains(
          remaining.interfacePaths,
          original.interfacePaths.filter((path) => !lost.includes(path))
        )
      )
        continue
      const originalSources = original.ownerPaths.filter(
        (path) => !isTest(path) && /\.[cm]?[jt]sx?$/.test(path)
      )
      // Explicit evidence without an import path may observe the owner through IPC or files.
      const reachable = new Set(reached(originalSources))
      const unproven = evidence(original).filter(
        (test) => !reachable.has(test) && after.files.has(test)
      )
      const verified = lost.every((path) => {
        const destinations = owner(headManifest, path)
        if (owner(baseManifest, path).length !== 1 || destinations.length !== 1) return false
        const [targetId, target] = destinations[0]
        const previous = baseManifest.modules[targetId]
        if (
          (original.interfacePaths.includes(path) && !target.interfacePaths.includes(path)) ||
          (original.testFiles.owner.includes(path) && !target.testFiles.owner.includes(path))
        )
          return false
        if (path.startsWith('test/fixtures/')) {
          // Fixture data routes to its reader suites; ownership must not change that plan.
          const lanes = (manifest) =>
            classifyChanges([{ path, status: 'modified' }], undefined, { moduleManifest: manifest })
          if (
            !contains(lanes(headManifest).lanes, lanes(baseManifest).lanes) ||
            !previous ||
            !contains(target.ownerPaths, previous.ownerPaths) ||
            !['owner', 'contract', 'consumer'].every((kind) =>
              contains(target.testFiles[kind], previous.testFiles[kind])
            ) ||
            !contains(target.interfacePaths, previous.interfacePaths) ||
            !contains(target.consumerModules, previous.consumerModules) ||
            !contains(target.capabilityOverlays, previous.capabilityOverlays) ||
            fixtureTestPatterns(path).length === 0
          )
            return false
          const baseline = plan(path, baseEffective)
          const candidate = plan(path, effective)
          return (
            candidate.mode === baseline.mode && contains(candidate.testFiles, baseline.testFiles)
          )
        }
        // Source moves create new modules; existing modules keep their reviewed boundaries.
        if (previous || !sharedSource(path)) return false
        if (
          target.fallbackCapability !== original.fallbackCapability ||
          !contains(target.capabilityOverlays, original.capabilityOverlays) ||
          !target.ownerPaths.every((entry) =>
            owner(baseManifest, entry).some(
              ([origin]) => baseManifest.modules[origin].fullTestReason
            )
          ) ||
          !contains(
            target.consumerModules,
            original.consumerModules.filter((consumer) => consumer !== targetId)
          )
        )
          return false
        if (target.fullTestReason) return true
        if (!isTest(path)) {
          const text = after.read(path)
          if (
            text === undefined ||
            catalogSurface(path) ||
            runtimePaths.has(path) ||
            dynamicMarkers(text, path).length ||
            !strict.dependencies(path).complete
          )
            return false
        }
        const selection = plan(path, effective)
        if (selection.mode !== 'selective') return false
        const selected = new Set(selection.testFiles)
        // Editing a registered test runs it directly; implementation edits carry the obligations.
        if (isTest(path) && !target.interfacePaths.includes(path)) return selected.has(path)
        const excluded = registry ? createPackageTestPlan([path], registry).excluded : []
        // Every statically reachable test and every unproven explicit contract follows the move.
        return [...reached([path]), ...unproven].every(
          (test) =>
            selected.has(test) ||
            test === path ||
            excluded.some((root) => test.startsWith(root + '/'))
        )
      })
      if (!verified) continue
      for (const path of lost) result.paths.add(`${id}:${path}`)
      for (const test of original.testFiles.owner.filter((test) => lost.includes(test)))
        result.ownerTests.add(`${id}:${test}`)
      if (remaining.fullTestReason !== original.fullTestReason) result.rewordedOwners.add(id)
    }
    return result
  } catch {
    return empty()
  }
}
