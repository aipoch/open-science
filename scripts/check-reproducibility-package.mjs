/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  packageRegistry,
  packageVerificationPlan,
  verificationPlanFromArguments,
  isolatedPackageEnvironment
} from './package-verification-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:reproducibility-package.')
const selection = verificationPlanFromArguments()
if (!selection.tests.includes('packages/reproducibility')) {
  console.log('Reproducibility package verification: skipped by package selection')
  process.exit(0)
}
// Derive prerequisites from the shared registry; only this family's tests run here.
const plan = packageVerificationPlan(packageRegistry(), ['packages/reproducibility'])
console.log('Reproducibility package verification:', JSON.stringify(plan))
const temporary = mkdtempSync(join(tmpdir(), 'reproducibility-package-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = isolatedPackageEnvironment()
const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, env, stdio: 'inherit' })
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2))
try {
  const archives = {}
  for (const packageRoot of plan.builds) {
    const name = packageRoot.slice('packages/'.length)
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
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], directory)
    if (name === 'reproducibility') {
      npm(['run', 'typecheck'], directory)
      if (!process.argv.includes('--skip-tests')) npm(['test'], directory)
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
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  // Run before the general consumer: the identity entry must not eagerly load the root or its dependencies.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {notebookHelperEvidenceKey} from '@aipoch/reproducibility/helper-identity'
const require = createRequire(import.meta.url)
const entry = require.resolve('@aipoch/reproducibility/helper-identity')
assert.deepEqual(Object.keys(require.cache), [entry])
assert.equal(require(entry).notebookHelperEvidenceKey, notebookHelperEvidenceKey)
assert.equal(notebookHelperEvidenceKey({skillIdentity:'skill',helperId:'helper',registeredGeneration:'generation',sourceDigest:'digest'}), 'skill\\0helper\\0generation\\0digest')
`
    ],
    { cwd: consumer, env, stdio: 'inherit' }
  )
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
import {notebookHelperEvidenceKey} from '@aipoch/reproducibility/helper-identity'
const require = createRequire(import.meta.url)
assert.ok(realpathSync(require.resolve('@aipoch/reproducibility')).startsWith(process.cwd()))
assert.equal(require('@aipoch/reproducibility').compareReproducedContent,compareReproducedContent)
assert.equal(require('@aipoch/reproducibility/contracts').outputComparisonPolicySchema,outputComparisonPolicySchema)
assert.equal(require('@aipoch/reproducibility/comparison').outputComparisonPolicySchema,comparisonSchema)
assert.equal(comparisonSchema,outputComparisonPolicySchema)
assert.equal(require('@aipoch/reproducibility/execution-context').notebookExecutionContextSchema,notebookExecutionContextSchema)
assert.equal(notebookExecutionContextSchema.safeParse({}).success,false)
assert.equal(require('@aipoch/reproducibility').notebookHelperEvidenceKey,notebookHelperEvidenceKey)
assert.equal(notebookHelperEvidenceKey({skillIdentity:'skill',helperId:'helper',registeredGeneration:'generation',sourceDigest:'digest'}), 'skill\\0helper\\0generation\\0digest')
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
