/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Build and test copied packages, then consume their tarballs outside the repository.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { familyVerificationPlan, isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this check through npm run check:notebook-packages.')
const plan = familyVerificationPlan(['notebook-syntax', 'notebook-code-risk', 'notebook-analysis'])
console.log('Notebook package verification:', JSON.stringify(plan))
if (plan.builds.length === 0) process.exit(0)
const temporary = mkdtempSync(join(tmpdir(), 'notebook-packages-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = { ...isolatedPackageEnvironment(), npm_config_cache: join(temporary, 'cache') }
// An explicit cache may supply offline dependencies, never node_modules or source resolution.
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'inherit' })
const npmRun = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd)

try {
  const tarballs = []
  for (const name of plan.builds) {
    const directory = join(temporary, name)
    mkdirSync(directory)
    for (const file of [
      'src',
      ...(name === 'notebook-syntax' ? ['assets'] : []),
      ...(name === 'notebook-analysis' ? ['test'] : []),
      'package.json',
      'tsconfig.json',
      'tsconfig.test.json',
      'vitest.config.ts',
      'README.md',
      'LICENSE',
      'tsc.cjs'
    ]) {
      cpSync(join(root, 'packages', name, file), join(directory, file), { recursive: true })
    }
    npmRun(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...offline,
        ...(tarballs.length ? ['--no-save', tarballs[0]] : [])
      ],
      directory
    )
    npmRun(['run', 'typecheck'], directory)
    if (!process.argv.includes('--skip-tests') && plan.tests.includes(name))
      npmRun(['test'], directory)
    npmRun(['pack', '--pack-destination', temporary], directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    tarballs.push(join(temporary, `aipoch-${name}-${manifest.version}.tgz`))
  }

  const consumer = join(temporary, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1' }
    })
  )
  npmRun(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline, ...tarballs],
    consumer
  )
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withParsedNotebookSource } from '@aipoch/notebook-syntax'
${plan.builds.includes('notebook-code-risk') ? "import { analyzeNotebookCodeRisk } from '@aipoch/notebook-code-risk'" : ''}
${
  plan.builds.includes('notebook-analysis')
    ? `import { NotebookDependencyAnalyzer } from '@aipoch/notebook-analysis'
import type { NotebookAnalysisRun } from '@aipoch/notebook-analysis/contracts'
// @ts-expect-error Storage implementation types are not part of the public contract.
import type { NotebookDependencyAnalysisSidecar } from '@aipoch/notebook-analysis/contracts'
import { analyzePythonNotebookSource } from '@aipoch/notebook-analysis'
import { analyzeRNotebookSource } from '@aipoch/notebook-analysis'
import { analyzeReplNotebookSource } from '@aipoch/notebook-analysis'
import * as projection from '@aipoch/notebook-analysis'`
    : ''
}
import * as powershell from '@aipoch/notebook-syntax/powershell'
const require = createRequire(import.meta.url)
for (const name of ${JSON.stringify(plan.builds)}) {
  const specifier = '@aipoch/' + name
  assert.ok(realpathSync(require.resolve(specifier)).startsWith(process.cwd()))
  for (const privatePath of ['/src/index', '/dist/index.js']) {
    assert.throws(() => require(specifier + privatePath), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'})
  }
}
${
  plan.builds.includes('notebook-analysis')
    ? `assert.equal(require('@aipoch/notebook-analysis').NotebookDependencyAnalyzer, NotebookDependencyAnalyzer)
assert.equal(typeof projection.projectNotebookFileDependencies, 'function')
assert.equal('NotebookDependencyProjector' in projection, false)
for (const internal of ['projection', 'python', 'r', 'repl']) {
  assert.throws(() => require('@aipoch/notebook-analysis/' + internal), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'})
}
`
    : ''
}
${plan.builds.includes('notebook-code-risk') ? `assert.equal(require('@aipoch/notebook-code-risk').analyzeNotebookCodeRisk, analyzeNotebookCodeRisk)` : ''}
assert.equal(typeof powershell.parsePowerShellCommands, 'function')
for (const [language, source] of [['python','x = 1'], ['r','x <- 1'], ['bash','echo hello'], ['javascript','globalThis.x = 1']] as const) {
  assert.equal((await withParsedNotebookSource(language, source, root => root.text)).state, 'ok')
}
${
  plan.builds.includes('notebook-analysis')
    ? `for (const facts of [await analyzePythonNotebookSource('x = 1'), await analyzeRNotebookSource('x <- 1'), await analyzeReplNotebookSource('globalThis.x = 1')]) {
  assert.equal(facts.facts.state, 'available')
}
`
    : ''
}
${
  plan.builds.includes('notebook-code-risk')
    ? `assert.ok((await analyzeNotebookCodeRisk('python', 'import os; os.remove("target.txt")')).length)
const target = join(process.cwd(), 'target.txt')
const source = 'require("fs").writeFileSync("target.txt", "new")'
const context = {workingDirectory:process.cwd()}
const before = await analyzeNotebookCodeRisk('repl', source, context)
await writeFile(target, 'keep')
const after = await analyzeNotebookCodeRisk('repl', source, context)
assert.ok(after.some(finding => finding.operation.includes('existing-file overwrite')))
assert.notDeepEqual(after, before)
`
    : ''
}
${
  plan.builds.includes('notebook-analysis')
    ? `const runs: NotebookAnalysisRun[] = [
  {runId:'a',cellId:'a',kernelKind:'python',kernelEpochId:'epoch',status:'completed',script:'x = 1',workingFiles:[]},
  {runId:'b',cellId:'b',kernelKind:'python',kernelEpochId:'epoch',status:'completed',script:'y = x',workingFiles:[]}
]
const options = {repository:{readSessionRuns:async () => runs},cachePath:() => join(process.cwd(),'cache','dependency-analysis.json')}
const request = {projectId:'project',sessionId:'session'}
const first = await new NotebookDependencyAnalyzer(options).project(request)
assert.deepEqual(first.dependenciesByRunId?.b, ['a'])
assert.deepEqual(await new NotebookDependencyAnalyzer(options).project(request), first)
assert.ok((await readFile(options.cachePath(), 'utf8')).length)
`
    : ''
}
console.log('Independent Notebook tarballs: declared types, exports, grammars, fresh risk evidence and persisted analysis passed.')

`
  )
  run(
    process.execPath,
    [
      join(consumer, 'node_modules/typescript/bin/tsc'),
      'consumer.mts',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict'
    ],
    consumer
  )
  // Remove the copied build/test trees before consuming, so no sibling source is available.
  for (const name of plan.builds) rmSync(join(temporary, name), { recursive: true })
  npmRun(
    ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...offline],
    consumer
  )
  run(process.execPath, ['consumer.mjs'], consumer)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
