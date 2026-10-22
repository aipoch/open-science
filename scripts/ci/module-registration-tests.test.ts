import { expect, it } from 'vitest'
import { moduleRegistrationTests } from './module-registration-tests.mjs'

it('selects policy, architecture and literal manifest readers without consulting candidate ownership', () => {
  const files = [
    'scripts/ci/module-test-impact.test.ts',
    'src/owner.architecture.test.ts',
    'src/component.test.tsx',
    'src/ordinary.test.ts',
    'src/module-impact.ts',
    'packages/example/src/example.test.ts',
    'docs/module-impact.md',
    'scripts/ci/release-certification-evidence.test.ts'
  ]
  expect(
    moduleRegistrationTests(files, (path: string) =>
      path === 'src/component.test.tsx'
        ? "readFileSync('scripts/ci/module-impact/example.json')"
        : ''
    )
  ).toEqual(files.slice(0, 3).sort())
})

it('includes host and package tier proofs alongside registration preservation', () => {
  const files = [
    'scripts/ci/host-test-impact.test.ts',
    'scripts/ci/package-host-test-impact.test.ts',
    'scripts/ci/module-graph/retirement.test.ts',
    'scripts/ci/host-owner-split.test.ts'
  ]
  expect(moduleRegistrationTests(files, () => '')).toEqual([...files].sort())
})
