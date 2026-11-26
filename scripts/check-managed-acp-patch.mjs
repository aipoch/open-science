import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const packageName = '@agentclientprotocol/claude-agent-acp'
const expectedVersion = '0.70.0'
const entry = process.env.ACP_ADAPTER_PATH ?? process.argv[2]
if (!entry) throw new Error('ACP_ADAPTER_PATH or an ACP adapter entry path is required.')
const packageRoot = resolve(dirname(entry), '..')
const installedPackage = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))

if (installedPackage.version !== expectedVersion) {
  throw new Error(
    `${packageName} patch target mismatch: installed ${installedPackage.version}, expected ${expectedVersion}. Update the dependency, lockfile, patch, and integrity check together.`
  )
}

const acpAgent = await import(pathToFileURL(resolve(packageRoot, 'dist/acp-agent.js')).href)
const launch = await import(pathToFileURL(resolve(packageRoot, 'dist/open-science-launch.js')).href)

if (
  typeof launch.needsFileConfiguration !== 'function' ||
  typeof launch.spawnWithFileConfiguration !== 'function'
) {
  throw new Error(`${packageName} Windows configuration transport patch is incomplete. Run npm ci.`)
}

if (typeof acpAgent.waitForMcpServers !== 'function') {
  throw new Error(
    `${packageName} patch is incomplete: waitForMcpServers is not exported. Run npm ci; do not edit node_modules manually.`
  )
}

console.log(`Verified ${packageName}@${expectedVersion} patch integrity.`)
