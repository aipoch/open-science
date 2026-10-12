/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { sourceSnapshot, createConsumerDependencyReader } from './consumer-retirement.mjs'
import { isModuleImpactRegistrationPath } from './load-module-impact.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'

// Registration-only splits can correct mixed host layers without authorizing source changes
// or dropping contracts. This proof runs from trusted-base policy, never candidate flags.
export function verifiedHostOwnerSplits(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  const empty = () => ({ paths: new Set(), ownerTests: new Set(), consumers: new Set() })
  try {
    const candidates = Object.entries(headManifest.modules).flatMap(([id, target]) => {
      if (baseManifest.modules[id]) return []
      const originals = Object.entries(baseManifest.modules).filter(
        ([, original]) =>
          target.ownerPaths.length &&
          target.ownerPaths.every((path) => original.ownerPaths.includes(path))
      )
      if (originals.length !== 1) return []
      const [originalId, original] = originals[0]
      const remaining = headManifest.modules[originalId]
      if (
        !remaining ||
        original.fullTestReason ||
        remaining.fullTestReason ||
        target.fullTestReason ||
        // Host composition can own build scripts and test harnesses, but shared, preload
        // and package source boundaries require their own reviewed policy.
        [...original.ownerPaths, ...remaining.ownerPaths].some((path) =>
          /^(?:src\/(?!main\/|renderer\/)|packages\/)/.test(path)
        ) ||
        target.ownerPaths.some(
          (path) => !/^src\/(?:main|renderer)\//.test(path) || remaining.ownerPaths.includes(path)
        ) ||
        !target.ownerPaths.every((path) => /\.[cm]?[jt]sx?$/.test(path)) ||
        target.fallbackCapability !== original.fallbackCapability ||
        !original.capabilityOverlays.every((overlay) =>
          target.capabilityOverlays.includes(overlay)
        ) ||
        !original.consumerModules.every((consumer) => target.consumerModules.includes(consumer)) ||
        !original.interfacePaths
          .filter((path) => target.ownerPaths.includes(path))
          .every((path) => target.interfacePaths.includes(path))
      )
        return []
      return [{ id, target, originalId, original, remaining }]
    })
    if (!candidates.length) return empty()
    const changed = execFileSync('git', ['diff', '--name-only', '-z', base, head], { cwd })
      .toString()
      .split('\0')
      .filter(Boolean)
    if (!changed.length || changed.some((path) => !isModuleImpactRegistrationPath(path)))
      return empty()
    const before = sourceSnapshot(base, cwd),
      after = sourceSnapshot(head, cwd)
    const edges = [before, after].flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json')))
    )
    // Registration moves preserve source bytes. Use import/runtime relationships, including
    // type and mock edges; host globals alone do not make those relationships incomplete.
    const inspect = createConsumerDependencyReader(after, edges)
    // Removing old evidence needs stronger proof: a known import does not explain
    // every filesystem/IPC dependency exercised by that test.
    const inspectRetirement = createConsumerDependencyReader(after, edges, { staticOnly: true })
    const result = empty()
    const verifiedOriginals = new Map()
    for (const { target, originalId, original, remaining } of candidates) {
      if (
        !target.ownerPaths.every(
          (path) => before.read(path) !== undefined && before.read(path) === after.read(path)
        )
      )
        continue
      const baseline = createAffectedTestPlan(
        target.ownerPaths.map((path) => ({ path, status: 'modified' })),
        { status: 'not-used', testFiles: [] },
        baseManifest
      )
      if (baseline.mode !== 'selective') continue
      const testFiles = baseline.testFiles.filter((path) => path.startsWith('src/'))
      const owners = new Set(target.ownerPaths)
      const evidence = new Set(Object.values(target.testFiles).flat())
      // Every reachable or uncertain test in the old plan must follow the extracted owner. Tests can
      // observe a contract through IPC/filesystem state even without a static import.
      if (
        testFiles.some((test) => {
          if (evidence.has(test)) return false
          const dependency = inspect(test, owners)
          return dependency.reachable || !dependency.complete
        })
      )
        continue
      // Retain explicit contracts and non-host evidence even when imports cannot express why.
      if (
        [
          ...original.testFiles.contract,
          ...Object.values(original.testFiles)
            .flat()
            .filter((test) => !test.startsWith('src/'))
        ].some((test) => !evidence.has(test))
      )
        continue
      // Explicit evidence with no demonstrable old source path can be a
      // behavioral contract. Its absence from the graph cannot authorize dropping it.
      const originalSources = new Set(
        original.ownerPaths.filter((path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path))
      )
      if (
        Object.values(original.testFiles)
          .flat()
          .some((test) => !evidence.has(test) && !inspect(test, originalSources).reachable)
      )
        continue
      const movedTests = original.testFiles.owner.filter((test) => owners.has(test))
      if (movedTests.some((test) => !target.testFiles.owner.includes(test))) continue
      const remainingEvidence = new Set(Object.values(remaining.testFiles).flat())
      const remainingOwners = new Set(remaining.ownerPaths)
      if (
        movedTests.some((test) => {
          if (remainingEvidence.has(test)) return false
          const previous = inspectRetirement(test, originalSources)
          if (!previous.complete || !previous.reachable) return true
          const dependency = inspectRetirement(test, remainingOwners)
          return dependency.reachable || !dependency.complete
        })
      )
        continue
      verifiedOriginals.set(originalId, { original, remaining })
      for (const path of target.ownerPaths) result.paths.add(`${originalId}:${path}`)
      for (const test of movedTests) result.ownerTests.add(`${originalId}:${test}`)
    }
    // A moved source still exists, so the ordinary retirement rule deliberately retains
    // its old registration. Once the transfer is proven, follow the remaining owner instead.
    for (const [id, { original, remaining }] of verifiedOriginals) {
      const oldOwners = new Set(original.ownerPaths)
      const remainingOwners = new Set(remaining.ownerPaths)
      for (const test of original.testFiles.consumer) {
        if (remaining.testFiles.consumer.includes(test)) continue
        const before = inspectRetirement(test, oldOwners)
        const after = inspectRetirement(test, remainingOwners)
        if (before.complete && before.reachable && after.complete && !after.reachable)
          result.consumers.add(`${id}:${test}`)
      }
    }
    return result
  } catch {
    return empty()
  }
}

// Source-changing transfers retain relationships in both revisions. Host facilities are
// represented by explicit contracts/runtime edges; retiring old evidence stays strict.
export function verifiedHostSourceMoves(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  const empty = () => ({ paths: new Set(), ownerTests: new Set(), consumers: new Set() })
  const hostPath = (path) => /^src\/(?:main|renderer)\/.*\.[cm]?[jt]sx?$/.test(path)
  const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  const protectedOwner = (module) =>
    module.fullTestReason ||
    module.ownerPaths.some((path) => /^(?:src\/(?!main\/|renderer\/)|packages\/)/.test(path))
  const evidence = (module) => new Set(Object.values(module.testFiles).flat())
  try {
    const transfers = Object.entries(baseManifest.modules).flatMap(([id, original]) => {
      const remaining = headManifest.modules[id]
      if (!remaining || protectedOwner(original) || protectedOwner(remaining)) return []
      const paths = original.ownerPaths.filter((path) => !remaining.ownerPaths.includes(path))
      if (!paths.length || paths.some((path) => !hostPath(path))) return []
      const targets = new Map()
      for (const path of paths) {
        const origins = Object.values(baseManifest.modules).filter((module) =>
          module.ownerPaths.includes(path)
        )
        const destinations = Object.entries(headManifest.modules).filter(([, module]) =>
          module.ownerPaths.includes(path)
        )
        if (origins.length !== 1 || destinations.length !== 1) return []
        const [targetId, target] = destinations[0]
        if (protectedOwner(target) || !target.ownerPaths.every(hostPath)) return []
        const move = targets.get(targetId) ?? { target, paths: [] }
        move.paths.push(path)
        targets.set(targetId, move)
      }
      return [{ id, original, remaining, targets }]
    })
    if (!transfers.length) return empty()
    const changed = execFileSync('git', ['diff', '--name-only', '-z', base, head], { cwd })
      .toString()
      .split('\0')
      .filter(Boolean)
    // Keep the registration-only exception separate, and never accept candidate policy changes.
    if (
      !changed.some((path) => !isModuleImpactRegistrationPath(path)) ||
      changed.some(
        (path) =>
          !isModuleImpactRegistrationPath(path) &&
          !/^src\/(?:main|renderer|shared)\/.*\.[cm]?[jt]sx?$/.test(path)
      )
    )
      return empty()
    const before = sourceSnapshot(base, cwd)
    const after = sourceSnapshot(head, cwd)
    const registeredTests = new Set(
      Object.values(baseManifest.modules).flatMap((module) => [...evidence(module)])
    )
    if (
      changed.some(
        (path) =>
          !isModuleImpactRegistrationPath(path) &&
          (after.read(path) === undefined ||
            (before.files.has(path) && (isTest(path) || registeredTests.has(path))))
      )
    )
      return empty()
    const edges = [before, after].flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json')))
    )
    const inspectBefore = createConsumerDependencyReader(before, edges)
    const inspectAfter = createConsumerDependencyReader(after, edges)
    const retireBefore = createConsumerDependencyReader(before, edges, { staticOnly: true })
    const retireAfter = createConsumerDependencyReader(after, edges, { staticOnly: true })
    const result = empty()
    for (const { id, original, remaining, targets } of transfers) {
      const originalSources = new Set(original.ownerPaths.filter((path) => !isTest(path)))
      const remainingSources = new Set(remaining.ownerPaths.filter((path) => !isTest(path)))
      const canRetire = (test) => {
        const previous = retireBefore(test, originalSources)
        const current = retireAfter(test, remainingSources)
        return previous.complete && previous.reachable && current.complete && !current.reachable
      }
      const remainingEvidence = evidence(remaining)
      const verified = [...targets.values()].every(({ target, paths }) => {
        if (
          target.fallbackCapability !== original.fallbackCapability ||
          !original.capabilityOverlays.every((overlay) =>
            target.capabilityOverlays.includes(overlay)
          ) ||
          !original.consumerModules.every((consumer) =>
            target.consumerModules.includes(consumer)
          ) ||
          !original.interfacePaths
            .filter((path) => paths.includes(path))
            .every((path) => target.interfacePaths.includes(path)) ||
          paths.some((path) => before.read(path) === undefined || after.read(path) === undefined)
        )
          return false
        const baseline = createAffectedTestPlan(
          paths.map((path) => ({ path, status: 'modified' })),
          { status: 'not-used', testFiles: [] },
          baseManifest
        )
        if (baseline.mode !== 'selective') return false
        const targetEvidence = evidence(target)
        const movedSources = new Set(paths.filter((path) => !isTest(path)))
        const targetSources = new Set(target.ownerPaths.filter((path) => !isTest(path)))
        if (
          baseline.testFiles.some((test) => {
            if (targetEvidence.has(test)) return false
            if (!test.startsWith('src/')) return true
            const previous = inspectBefore(test, movedSources)
            const current = inspectAfter(test, targetSources)
            return (
              previous.reachable || !previous.complete || current.reachable || !current.complete
            )
          }) ||
          [...evidence(original)].some((test) => {
            if (targetEvidence.has(test)) return false
            if (original.testFiles.contract.includes(test) || !test.startsWith('src/')) return true
            const previous = inspectBefore(test, originalSources)
            return !previous.reachable || !previous.complete
          })
        )
          return false
        return original.testFiles.owner
          .filter((test) => paths.includes(test))
          .every(
            (test) =>
              target.testFiles.owner.includes(test) &&
              (remainingEvidence.has(test) || canRetire(test))
          )
      })
      // Retirement is authorized only once all surviving paths moved from this owner are covered.
      if (!verified) continue
      for (const { paths } of targets.values()) {
        for (const path of paths) result.paths.add(`${id}:${path}`)
        for (const test of original.testFiles.owner.filter((test) => paths.includes(test)))
          result.ownerTests.add(`${id}:${test}`)
      }
      for (const test of original.testFiles.consumer) {
        if (!remaining.testFiles.consumer.includes(test) && canRetire(test))
          result.consumers.add(`${id}:${test}`)
      }
    }
    return result
  } catch {
    return empty()
  }
}
