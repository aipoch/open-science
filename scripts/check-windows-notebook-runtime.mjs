/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmRepair } from '../packages/notebook-network-sandbox/vendor/windows-runtime/npm/prepare.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function checkWindowsNotebookRuntime({
  root = repositoryRoot,
  platform = process.platform,
  architecture = process.arch
} = {}) {
  if (platform !== 'win32') return
  const vendor = join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime')
  const runtime = join(vendor, architecture)
  const setupError = new Error(
    'Windows Notebook runtime is missing, incomplete, or out of date.\n' +
      'Prepare the pinned runtime before starting development:\n' +
      'pwsh -File packages/notebook-network-sandbox/vendor/windows-runtime/build.ps1 -BuildRoot C:\\os-runtime-build\n' +
      'node packages/notebook-network-sandbox/vendor/windows-runtime/npm/prepare.mjs\n' +
      'See CONTRIBUTING.md for Windows build prerequisites.'
  )
  for (const file of [
    'node/node.exe',
    'node/node_modules/npm/bin/npm-cli.js',
    'powershell/pwsh.exe',
    'build.json'
  ]) {
    if (!existsSync(join(runtime, file))) throw setupError
  }
  try {
    const sources = JSON.parse(readFileSync(join(vendor, 'sources.json'), 'utf8'))
    const marker = JSON.parse(
      readFileSync(join(runtime, 'build.json'), 'utf8').replace(/^\uFEFF/, '')
    )
    if (
      marker.node !== sources.node.version ||
      marker.powershell !== sources.powershell.version ||
      typeof sources.powershell.commit !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(sources.powershell.commit) ||
      marker.powershellSourceCommit !== sources.powershell.commit ||
      !Array.isArray(marker.patches) ||
      ![
        'libuv-f46e4246b5277fe1c5888b88b24d8b78020dd4f8',
        'node-appcontainer-package-scope-v2',
        'powershell-appcontainer-v1',
        'powershell-source-archive-metadata-v1',
        npmRepair
      ].every((patch) => marker.patches.includes(patch))
    ) {
      throw setupError
    }
  } catch {
    throw setupError
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkWindowsNotebookRuntime()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
