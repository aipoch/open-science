/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Install/build/test outside the repository, then run only the packed public interfaces.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isolatedPackageEnvironment } from './package-verification-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run through npm run check:diagnostics-package.')
const temporary = mkdtempSync(join(tmpdir(), 'diagnostics-package-'))
const offline = process.argv.includes('--offline') ? ['--offline'] : []
const env = {
  ...isolatedPackageEnvironment(),
  npm_config_cache: process.env.npm_config_cache ?? join(temporary, 'cache')
}
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
const npm = (args, cwd) => run([npmCli, ...args], cwd)
try {
  const source = join(temporary, 'source')
  mkdirSync(source)
  for (const file of [
    'src',
    'package.json',
    'tsconfig.json',
    'tsconfig.test.json',
    'vitest.config.ts',
    'README.md',
    'LICENSE',
    'tsc.cjs'
  ]) {
    cpSync(join(root, 'packages/diagnostics', file), join(source, file), { recursive: true })
  }
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], source)
  npm(['run', 'typecheck'], source)
  npm(['test', '--', '--maxWorkers=1'], source)
  npm(['pack', '--pack-destination', temporary], source)
  const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const consumer = join(temporary, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.1', esbuild: '0.25.12' }
    })
  )
  npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...offline,
      join(temporary, `aipoch-diagnostics-${version}.tgz`)
    ],
    consumer
  )
  writeFileSync(
    join(consumer, 'consumer.mts'),
    `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { redactSensitiveText } from '@aipoch/diagnostics'
import { createLogger, initLogger, flushLogs, getLogFilePath, startDiagnosticOperation } from '@aipoch/diagnostics/node'
const require = createRequire(import.meta.url)
assert.equal(require('@aipoch/diagnostics/node').createLogger, createLogger)
assert.ok(realpathSync(require.resolve('@aipoch/diagnostics')).startsWith(process.cwd()))
for (const hidden of ['src/logger', 'dist/logger.js', 'session', 'session/database', 'dist/session/worker-entry.js']) {
  assert.throws(() => require('@aipoch/diagnostics/' + hidden), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
const logs = join(process.cwd(), 'logs')
mkdirSync(logs)
initLogger({ logDir: logs, mirrorToConsole: false })
const operation = startDiagnosticOperation(createLogger('installed-consumer'), { operation: 'acceptance' })
operation.complete({ apiKey: 'never-export-me' })
await flushLogs()
assert.equal(require('@aipoch/diagnostics/node').getLogFilePath(), getLogFilePath())
assert.ok(!readFileSync(getLogFilePath()!, 'utf8').includes('never-export-me'))
// Browser platform compilation fails if the root entry reaches Node builtins.
const browser = await build({ stdin: { contents: "import { redactSensitiveText } from '@aipoch/diagnostics'; globalThis.redacted = redactSensitiveText('apiKey=browser-secret')", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false })
const context: Record<string, unknown> = {}
runInNewContext(browser.outputFiles[0].text, context)
assert.equal(context.redacted, redactSensitiveText('apiKey=browser-secret'))
assert.ok(!String(context.redacted).includes('browser-secret'))
console.log('Independent diagnostics tarball: types, exports, shared identity, browser entry and log redaction passed.')
`
  )
  run(
    [
      join(consumer, 'node_modules/typescript/bin/tsc'),
      'consumer.mts',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict',
      '--skipLibCheck'
    ],
    consumer
  )
  // No copied implementation remains available during installed-consumer execution.
  rmSync(source, { recursive: true })
  run(['consumer.mjs'], consumer)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
