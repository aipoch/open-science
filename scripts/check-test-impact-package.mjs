/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { familyVerificationPlan, isolatedPackageEnvironment } from './package-verification-plan.mjs'

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:test-impact-package.')
if (!familyVerificationPlan(['test-impact']).tests.length) process.exit(0)
const root = fileURLToPath(new URL('../packages/test-impact/', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'test-impact-package-'))
const env = isolatedPackageEnvironment()
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
const npm = (args, cwd) => run([npmCli, ...args], cwd)
try {
  const source = join(work, 'source')
  mkdirSync(source)
  for (const file of [
    'src',
    'test',
    'package.json',
    'tsconfig.json',
    'tsconfig.test.json',
    'vitest.config.ts',
    'tsc.cjs',
    'README.md',
    'LICENSE'
  ])
    cpSync(join(root, file), join(source, file), { recursive: true })
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], source)
  npm(['run', 'build'], source)
  npm(['run', 'typecheck'], source)
  npm(['test'], source)
  const packed = JSON.parse(
    execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', work], {
      cwd: source,
      env,
      encoding: 'utf8'
    })
  )[0]
  for (const { path } of packed.files) {
    assert.match(path, /^(?:dist\/|README\.md$|LICENSE$|package\.json$)/)
    assert.ok(!/\.test\./.test(path), `Packed test: ${path}`)
  }
  const consumer = join(work, 'consumer')
  mkdirSync(consumer)
  cpSync(join(source, 'test/installed.mjs'), join(consumer, 'installed.mjs'))
  rmSync(source, { recursive: true })
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { '@aipoch/test-impact': `file:${join(work, packed.filename)}` },
      devDependencies: { '@types/node': '^22.19.1' }
    })
  )
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], consumer)
  writeFileSync(
    join(consumer, 'consumer.mts'),
    "import {analyzeRevision, type StaticImpactReport} from '@aipoch/test-impact'\nconst report: Promise<StaticImpactReport> = analyzeRevision({repository: '.', revision: 'HEAD'})\nvoid report\n"
  )
  run(
    [
      'node_modules/typescript/bin/tsc',
      'consumer.mts',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict',
      '--noEmit'
    ],
    consumer
  )
  run(['installed.mjs'], consumer)
} finally {
  rmSync(work, { recursive: true, force: true })
}
