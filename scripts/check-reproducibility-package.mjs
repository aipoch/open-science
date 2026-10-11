/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reproducibilityPackageVerificationPlan } from './ci/package-test-impact.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:reproducibility-package.')
const ci = process.argv.includes('--ci')
const selected =
  ci && process.env.OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS
    ? JSON.parse(process.env.OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS)
    : undefined
const excluded =
  ci && process.env.OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS
    ? JSON.parse(process.env.OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS)
    : undefined
const plan = reproducibilityPackageVerificationPlan(selected, excluded)
console.log('Reproducibility package verification:', JSON.stringify(plan))
if (!plan.tests.length) process.exit(0)
const temporary = mkdtempSync(join(tmpdir(), 'reproducibility-package-'))
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, env, stdio: 'inherit' })
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2))
try {
  const archives = {}
  for (const name of plan.builds) {
    const directory = join(temporary, name)
    cpSync(join(root, 'packages', name), directory, {
      recursive: true,
      filter: (path) =>
        !['node_modules', 'dist', '.cache', 'package-lock.json'].includes(
          path.split(/[\\/]/).at(-1)
        )
    })
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    // Dependencies resolve only from published-shaped archives, never workspace symlinks.
    for (const [dependency, archive] of Object.entries(archives)) {
      const specifier = 'file:' + archive
      if (Object.hasOwn(manifest.dependencies ?? {}, dependency))
        manifest.dependencies[dependency] = specifier
      manifest.overrides ??= {}
      manifest.overrides[dependency] = specifier
    }
    writeJson(join(directory, 'package.json'), manifest)
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], directory)
    if (name === 'reproducibility') {
      npm(['run', 'typecheck'], directory)
      npm(['test'], directory)
    }
    // Keep the release manifest's declared versions in the tarball.
    cpSync(join(root, 'packages', name, 'package.json'), join(directory, 'package.json'))
    npm(['pack', '--pack-destination', temporary], directory)
    archives[manifest.name] = join(temporary, `aipoch-${name}-${manifest.version}.tgz`)
  }
  const consumer = join(temporary, 'consumer')
  mkdirSync(consumer)
  writeJson(join(consumer, 'package.json'), {
    private: true,
    type: 'module',
    dependencies: { '@aipoch/reproducibility': 'file:' + archives['@aipoch/reproducibility'] },
    overrides: Object.fromEntries(
      Object.entries(archives)
        .filter(([name]) => name !== '@aipoch/reproducibility')
        .map(([name, path]) => [name, 'file:' + path])
    ),
    devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1' }
  })
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {realpathSync} from 'node:fs'
import {compareReproducedContent, validatePythonRandomState, createReproductionRecipes, projectCapturedArtifactReproducibility} from '@aipoch/reproducibility'
import {outputComparisonPolicySchema, type ArtifactReproducibilityRecipe} from '@aipoch/reproducibility/contracts'
import {outputComparisonPolicySchema as comparisonSchema} from '@aipoch/reproducibility/comparison'
import {notebookExecutionContextSchema} from '@aipoch/reproducibility/execution-context'
const require = createRequire(import.meta.url)
assert.ok(realpathSync(require.resolve('@aipoch/reproducibility')).startsWith(process.cwd()))
assert.equal(require('@aipoch/reproducibility').compareReproducedContent,compareReproducedContent)
assert.equal(require('@aipoch/reproducibility/contracts').outputComparisonPolicySchema,outputComparisonPolicySchema)
assert.equal(require('@aipoch/reproducibility/comparison').outputComparisonPolicySchema,comparisonSchema)
assert.equal(comparisonSchema,outputComparisonPolicySchema)
assert.equal(require('@aipoch/reproducibility/execution-context').notebookExecutionContextSchema,notebookExecutionContextSchema)
assert.equal(notebookExecutionContextSchema.safeParse({}).success,false)
for (const suffix of ['/src/index', '/dist/index.js', '/recipe', '/package.json'])
 assert.throws(()=>require('@aipoch/reproducibility'+suffix),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'})
assert.equal(validatePythonRandomState(undefined),undefined)
assert.equal(projectCapturedArtifactReproducibility({runs: []}),undefined)
assert.equal(outputComparisonPolicySchema.safeParse({}).success,false)
const recipes=createReproductionRecipes({inputPath: name=>name,fileIO:{digestFile:async()=>{throw Error('Not used')}}})
assert.equal(recipes.artifactReproducibilityRecipeValue({}),false)
const fixture: ArtifactReproducibilityRecipe | undefined = undefined
assert.equal(fixture,undefined)
const result=await compareReproducedContent({filename:'result.csv',expected:Buffer.from('a,b\\n1,2\\n'),actual:Buffer.from('a,b\\n1,2\\n')})
assert.equal(result.report.kind,'table')
assert.equal(result.report.outcome,'equal')
console.log('Clean tarball consumer: declarations, exports and comparison worker passed')
`
  )
  execFileSync(
    process.execPath,
    [
      join(consumer, 'node_modules/typescript/lib/tsc.js'),
      '--module',
      'NodeNext',
      '--target',
      'ES2023',
      '--strict',
      'consumer.mts'
    ],
    { cwd: consumer, env, stdio: 'inherit' }
  )
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: consumer, env, stdio: 'inherit' })
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
