import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { loadDerivedConsumers } from './module-derived-consumers.mjs'
import { createModuleTestPlan, modulesForPath } from './module-test-impact.mjs'
import suite from './notebook-analysis-native/suite.json'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')

it('retains explicit native behavioral evidence outside ordinary module test selection', () => {
  const manifest = loadModuleImpactManifest()
  expect(suite.coveredModules).toEqual(['notebook_analysis_engine'])
  expect(suite.testFiles).toEqual(
    readdirSync(resolve(root, 'packages/notebook-analysis/test/native'))
      .filter((name) => name.endsWith('.suite.ts'))
      .map((name) => `packages/notebook-analysis/test/native/${name}`)
      .sort()
  )
  expect(suite.testFiles).toHaveLength(8)
  for (const path of suite.testFiles) {
    expect(read(path)).not.toMatch(/\.(?:skip|skipIf|runIf|todo)\b/)
  }
  for (const path of [
    suite.entrypoint,
    'packages/notebook-analysis/test/native/setup.ts',
    ...suite.testFiles
  ]) {
    expect(manifest.modules.notebook_analysis_engine.ownerPaths, path).toContain(path)
  }
  for (const path of [suite.workflow, 'scripts/ci/notebook-analysis-native/suite.json']) {
    expect(modulesForPath(manifest, path), path).toEqual([])
  }
  const ordinary = [
    ...Object.values(manifest.modules).flatMap((module) => Object.values(module.testFiles).flat()),
    ...Object.values(loadDerivedConsumers().modules).flat(),
    ...createModuleTestPlan('notebook_analysis_engine').testFiles
  ]
  expect(ordinary.filter((path) => suite.testFiles.includes(path))).toEqual([])
  expect(ordinary).toContain('packages/notebook-analysis/src/dependency-analysis.chord.test.ts')
  expect(JSON.parse(read('package.json')).scripts['test:notebook-analysis-native']).toBe(
    'npm run test:native --prefix packages/notebook-analysis'
  )
  expect(JSON.parse(read('packages/notebook-analysis/package.json')).scripts['test:native']).toBe(
    'vitest run --config test/native/vitest.config.ts'
  )
})

it('ordinary discovery does not collect the native entrypoint', () => {
  const files = execFileSync(process.execPath, [vitest, 'list', '--filesOnly', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      VITEST_PORTABLE_CI: '0',
      OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: '[]',
      OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '[]'
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  expect(files).not.toContain('/notebook-analysis/test/native/')
  expect(files).toContain('dependency-analysis.chord.test.ts')
}, 30000)

it('the dedicated configuration discovers every declared native file', () => {
  const output = execFileSync(
    process.execPath,
    [vitest, 'list', '--config', suite.entrypoint, '--filesOnly', '--json'],
    { cwd: root, encoding: 'utf8' }
  )
  expect(
    JSON.parse(output)
      .map(({ file }: { file: string }) => resolve(file))
      .sort()
  ).toEqual(suite.testFiles.map((path) => resolve(root, path)).sort())
}, 30000)

it.each(['RUN_KERNEL', ...suite.requiredEnvironment])(
  'the real native entrypoint fails when %s is missing',
  (missing) => {
    const env = {
      ...process.env,
      ...suite.activation,
      ...Object.fromEntries(suite.requiredEnvironment.map((name) => [name, '/unused-runtime']))
    }
    delete env[missing]
    const run = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        '--config',
        suite.entrypoint,
        resolve(root, suite.testFiles[0]),
        '--reporter=default'
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 30000 }
    )
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(1)
    expect(run.stdout + run.stderr).toContain(`requires ${missing}`)
  },
  35000
)
