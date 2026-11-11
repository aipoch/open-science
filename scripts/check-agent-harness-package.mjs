/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = resolve(import.meta.dirname, '..')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:agent-harness-package')
const env = isolatedPackageEnvironment()
const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8' })
execFileSync(process.execPath, ['scripts/build-dev-packages.mjs', '--packages=agent-harness'], {
  cwd: root,
  stdio: 'inherit'
})
const source = join(root, 'packages/agent-harness')
console.log(npm(['run', 'typecheck'], source))
if (!process.argv.includes('--skip-tests')) console.log(npm(['test'], source))
const work = mkdtempSync(join(tmpdir(), 'agent-harness-consumer-'))
env.npm_config_cache = join(work, 'cache')
try {
  const [archive] = JSON.parse(
    npm(['pack', '--ignore-scripts', '--json', '--pack-destination', work], source)
  )
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { '@aipoch/agent-harness': `file:${join(work, archive.filename)}` }
    })
  )
  console.log(
    npm(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...(process.argv.includes('--offline') ? ['--offline'] : [])
      ],
      work
    )
  )
  copyFileSync(
    join(root, 'scripts/fixtures/agent-harness/consumer.mjs'),
    join(work, 'consumer.mjs')
  )
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: work, env, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
