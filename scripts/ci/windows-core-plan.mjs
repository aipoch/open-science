/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'
import { playwrightReaderTests } from './classify-pr-changes.mjs'

export const windowsCoreChecks = JSON.parse(
  readFileSync(new URL('./windows-core-checks.json', import.meta.url), 'utf8')
)

// These tests exercise the native supervisor even without the AppContainer lifecycle suite.
const nativeConsumers = [
  'windows_runtime',
  'windows_shell',
  'windows_service_timeout',
  'windows_sandbox'
]
export function withWindowsNativePrerequisites(checks) {
  return nativeConsumers.some((id) => checks.includes(id))
    ? [...new Set([...checks, 'windows_sandbox_source', 'windows_sandbox_build'])]
    : [...checks]
}

export function selectWindowsCoreChecks(plan, modulePlan, changes, manifest, event) {
  if (!plan.bundles.includes('windows_core')) return plan
  const available = Object.keys(windowsCoreChecks).filter((id) =>
    plan.lanes.includes(id === 'windows_path' ? 'windows_path' : 'windows_runtime')
  )
  const finish = (checks, reasons) => ({
    ...plan,
    windowsCoreChecks: withWindowsNativePrerequisites(checks),
    reasonChains: [...plan.reasonChains, ...reasons]
  })
  const all = (reason) => finish(available, [`Windows core: ${reason} -> all selected-lane checks`])
  if (!['pull_request', 'merge_group'].includes(event)) return all('manual validation')
  if (plan.mode !== 'selective' || modulePlan.mode !== 'selective')
    return all('full or uncertain impact')
  if (changes.some(({ status }) => !['modified', 'added'].includes(status)))
    return all('destructive or unknown change')

  const paths = changes.flatMap(({ path, previousPath }) => [path, previousPath].filter(Boolean))
  const direct = new Set(paths)
  for (const path of paths) {
    const owners = Object.values(manifest.modules).filter((module) =>
      module.ownerPaths.includes(path)
    )
    // Registered runtime documents/assets still need their owner's evidence. Playwright inputs
    // run in E2E lanes; their declared Vitest readers stay in the affected module plan.
    if (!owners.length && (/^(docs\/)|\.md$/.test(path) || playwrightReaderTests(path))) continue
    if (owners.length !== 1 || owners[0].fullTestReason) return all(`${path}: unbounded owner`)
    for (const test of [...owners[0].testFiles.owner, ...owners[0].testFiles.contract])
      direct.add(test)
  }
  const affected = new Set(modulePlan.testFiles)
  // shortcut: selected groups keep whole test files; split groups only when timings justify it.
  const checks = []
  const reasons = []
  for (const id of available) {
    const group = windowsCoreChecks[id]
    const input = paths.find((path) => group.paths?.some((prefix) => path.startsWith(prefix)))
    const ownerTest = group.tests.find((test) => direct.has(test))
    const consumerTest = group.tests.find((test) => affected.has(test))
    if (
      input ||
      ownerTest ||
      (consumerTest &&
        (event === 'merge_group' || id === 'windows_path' || id === 'windows_runtime'))
    ) {
      checks.push(id)
      reasons.push(
        `Windows core: ${input || ownerTest || consumerTest} -> ${id} (${input || ownerTest ? 'direct owner/contract' : 'affected consumer'})`
      )
    } else if (consumerTest) {
      reasons.push(
        `Windows core: ${consumerTest} -> ${id} deferred to merge queue (indirect integration)`
      )
    } else {
      reasons.push(`Windows core: no affected registered evidence -> omit ${id}`)
    }
  }
  // A platform overlay with no mapped evidence is not permission to skip its entire job.
  return checks.length
    ? finish(checks, reasons)
    : all('platform overlay has no mapped check evidence')
}

export function validWindowsCoreChecks(plan) {
  const checks = plan.windowsCoreChecks
  if (!Array.isArray(checks) || !checks.length || new Set(checks).size !== checks.length)
    return false
  const groups = checks.filter((id) => Object.hasOwn(windowsCoreChecks, id))
  const expected = withWindowsNativePrerequisites(groups)
  return (
    plan.bundles?.includes('windows_core') &&
    expected.length === checks.length &&
    expected.every((id) => checks.includes(id)) &&
    groups.every((id) =>
      plan.lanes.includes(id === 'windows_path' ? 'windows_path' : 'windows_runtime')
    )
  )
}
