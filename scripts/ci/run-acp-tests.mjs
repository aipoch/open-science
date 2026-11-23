import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(
  readFileSync(resolve(root, 'scripts/ci/acp-framework-coverage.json'), 'utf8')
)
const scopeArgument = process.argv.find((argument) => argument.startsWith('--scope='))
const scope = scopeArgument?.slice('--scope='.length) ?? 'full'

const supportedScopes = new Set(['baseline', 'specialized', 'representative', 'full'])
if (!supportedScopes.has(scope)) {
  throw new Error(
    `Unsupported ACP test scope: ${scope}. Use baseline, specialized, representative, or full.`
  )
}

const runtime = manifest.representative.runtime
const files = []
if (scope === 'baseline' || scope === 'full') files.push(...manifest.baseline)
if (scope === 'representative' || scope === 'full') files.push(...manifest.representative.files)
if (scope === 'specialized' || scope === 'full') {
  for (const frameworkFiles of Object.values(manifest.specialized)) files.push(...frameworkFiles)
}

if (scope === 'representative' || scope === 'full') {
  const requiredEnvironment = [runtime.adapterEnvironment, runtime.nativeEnvironment]
  const missingEnvironment = requiredEnvironment.filter(
    (name) => !process.env[name] || !existsSync(process.env[name])
  )
  if (missingEnvironment.length > 0) {
    throw new Error(
      `ACP ${scope} coverage requires installed representative runtime paths: ${missingEnvironment.join(', ')}`
    )
  }
}

const uniqueFiles = [...new Set(files)]
const missingFiles = uniqueFiles.filter((file) => !existsSync(resolve(root, file)))
if (missingFiles.length > 0) {
  throw new Error(`ACP coverage manifest references missing files: ${missingFiles.join(', ')}`)
}

const result = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...uniqueFiles, '--maxWorkers=1'],
  { cwd: root, env: process.env, stdio: 'inherit' }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
