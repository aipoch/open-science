/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const journeySpecs = {
  artifact_provenance: 'e2e/certification/artifact-provenance.spec.ts',
  notebook_lifecycle: 'e2e/certification/notebook-lifecycle.spec.ts',
  provider_bridge: 'e2e/certification/provider-bridge.spec.ts',
  remote_pairing: 'e2e/certification/remote-pairing.spec.ts',
  storage_migration: 'e2e/certification/storage-migration.spec.ts'
}

const platformNames = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows'
}
const playwrightCli = fileURLToPath(import.meta.resolve('@playwright/test/cli'))

export function selectReleaseSpecs(lanes, platform = process.platform) {
  const platformName = platformNames[platform]
  if (!platformName) throw new Error(`Unsupported Electron E2E platform: ${platform}`)

  const selected = new Set(lanes)
  return Object.entries(journeySpecs)
    .filter(([journey]) => selected.has(`e2e_${journey}_${platformName}`))
    .map(([, spec]) => spec)
}

export function releaseE2ECommand(specs) {
  return {
    executable: process.execPath,
    args: [playwrightCli, 'test', ...specs]
  }
}

export function runSelectedReleaseE2E(environment = process.env) {
  const lanes = JSON.parse(environment.PR_GATE_LANES ?? '[]')
  if (!Array.isArray(lanes) || lanes.some((lane) => typeof lane !== 'string')) {
    throw new Error('PR_GATE_LANES must be a JSON array of lane names.')
  }

  const specs = selectReleaseSpecs(lanes)
  if (specs.length === 0) throw new Error('No release E2E specs were selected for this platform.')

  const { executable, args } = releaseE2ECommand(specs)
  const result = spawnSync(executable, args, {
    env: environment,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    process.exitCode = runSelectedReleaseE2E()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
