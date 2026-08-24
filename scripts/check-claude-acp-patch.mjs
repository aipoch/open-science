import { createRequire } from 'node:module'

const packageName = '@agentclientprotocol/claude-agent-acp'
const expectedVersion = '0.70.0'
const require = createRequire(import.meta.url)
const installedPackage = require(`${packageName}/package.json`)

if (installedPackage.version !== expectedVersion) {
  throw new Error(
    `${packageName} patch target mismatch: installed ${installedPackage.version}, expected ${expectedVersion}. Update the dependency, lockfile, patch, and integrity check together.`
  )
}

const acpAgent = await import(`${packageName}/dist/acp-agent.js`)

if (typeof acpAgent.waitForMcpServers !== 'function') {
  throw new Error(
    `${packageName} patch is incomplete: waitForMcpServers is not exported. Run npm ci; do not edit node_modules manually.`
  )
}

console.log(`Verified ${packageName}@${expectedVersion} patch integrity.`)
