import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

it('tests the immutable package with read-only reusable release jobs and no source rebuild', () => {
  const source = readFileSync('.github/workflows/performance-package-dryrun.yml', 'utf8')
  const workflow = load(source) as {
    on: Record<string, unknown>
    permissions: Record<string, string>
    jobs: Record<
      string,
      {
        uses?: string
        with?: Record<string, unknown>
        steps?: { name: string; run?: string; env?: Record<string, string> }[]
      }
    >
  }
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'workflow_call'])
  expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
  expect(workflow.jobs.build).toEqual({
    uses: './.github/workflows/build.yml',
    with: { nightly: true, skip_verify: true, platform_name: 'macos-arm64' }
  })
  expect(workflow.jobs.smoke.uses).toBe('./.github/workflows/package-smoke.yml')
  expect(Object.keys(workflow.jobs)).toEqual(['build', 'smoke', 'performance'])
  const steps = workflow.jobs.performance.steps!
  const profile = steps.find((step) => step.name === 'Profile packaged startup and runtime')!
  expect(profile.run).toContain('--skip-build')
  expect(profile.env).toEqual({
    OPEN_SCIENCE_E2E_EXECUTABLE: '${{ steps.packaged.outputs.executable }}',
    OPEN_SCIENCE_E2E_EXPECTED_BUILD_SHA: '${{ github.sha }}'
  })
  expect(steps.some((step) => /build:e2e|npm run dev/.test(step.run ?? ''))).toBe(false)
})

it('dispatches the package plan through the existing runtime workflow without running the source soak', () => {
  const workflow = load(readFileSync('.github/workflows/runtime-resource-soak.yml', 'utf8')) as {
    jobs: Record<string, { if?: string; uses?: string }>
  }
  expect(workflow.jobs.packaged_performance).toEqual({
    if: "github.event_name == 'workflow_dispatch' && inputs.mode == 'package-macos-arm64'",
    uses: './.github/workflows/performance-package-dryrun.yml'
  })
  expect(workflow.jobs.runtime_resource_soak.if).toContain("inputs.mode != 'package-macos-arm64'")
})
