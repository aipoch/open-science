import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(
  readFileSync(resolve(root, 'scripts/ci/acp-framework-coverage.json'), 'utf8')
)
const runtime = manifest.representative.runtime
const runtimeRoot = resolve(root, runtime.root)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

execFileSync(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: runtimeRoot,
  stdio: 'inherit'
})

const patchDirectory = resolve(runtimeRoot, '.open-science-patches')
mkdirSync(patchDirectory, { recursive: true })
copyFileSync(
  resolve(runtimeRoot, '@agentclientprotocol+claude-agent-acp+0.70.0.patch'),
  resolve(patchDirectory, '@agentclientprotocol+claude-agent-acp+0.70.0.patch')
)
try {
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/patch-package/index.js'),
      '--error-on-fail',
      '--patch-dir',
      '.open-science-patches'
    ],
    { cwd: runtimeRoot, stdio: 'inherit' }
  )
} finally {
  rmSync(patchDirectory, { recursive: true, force: true })
}

const adapterPath = resolve(runtimeRoot, 'node_modules', runtime.adapter)
const resolverPath = resolve(runtimeRoot, 'node_modules', runtime.nativeResolver)
execFileSync(process.execPath, [resolve(root, 'scripts/check-managed-acp-patch.mjs')], {
  cwd: root,
  env: { ...process.env, ACP_ADAPTER_PATH: adapterPath },
  stdio: 'inherit'
})
const resolver = await import(pathToFileURL(resolverPath).href)
const nativePath = await resolver[runtime.nativeResolverExport]()
const environment = {
  [runtime.adapterEnvironment]: adapterPath,
  [runtime.nativeEnvironment]: nativePath
}

for (const [name, value] of Object.entries(environment)) {
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`)
  }
  console.log(`${name}=${value}`)
}
