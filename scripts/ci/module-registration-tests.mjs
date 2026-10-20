/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Architecture contracts sometimes read registration data rather than import an owner.
// Discover those readers independently of the candidate manifest they are checking.
export function moduleRegistrationTests(files, read) {
  return files
    .filter(
      (path) =>
        /\.test\.[cm]?[jt]sx?$/.test(path) &&
        ((path.startsWith('scripts/ci/') &&
          /module-|consumer-|owner-split|ci-integrity|pr-gate|platform-risk|test-impact|package-test|package-boundaries/.test(
            path
          )) ||
          (path.startsWith('src/') &&
            (path.includes('.architecture.test.') || /module-impact/.test(read(path)))))
    )
    .sort()
}

export function runModuleRegistrationTests({ cwd = process.cwd(), spawn = spawnSync } = {}) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const tests = moduleRegistrationTests(files, (path) => readFileSync(resolve(cwd, path), 'utf8'))
  if (!tests.length) throw Error('Missing module registration contract tests')
  console.log(`Module registration: ${tests.length} policy and architecture test files`)
  const result = spawn(
    process.execPath,
    [resolve(cwd, 'node_modules/vitest/vitest.mjs'), 'run', ...tests],
    {
      cwd,
      stdio: 'inherit'
    }
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runModuleRegistrationTests()
}
