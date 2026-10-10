/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { currentRuntimeTarget, runtimePackageName } from './runtime-package.mjs'

export async function locateBackend({ required = true } = {}) {
  if (process.versions.electron)
    throw new Error(
      'The CLI requires ordinary Node.js. Reinstall the desktop command-line launcher.'
    )
  const here = dirname(fileURLToPath(import.meta.url))
  for (const root of [here, join(here, '../..')]) {
    const entry = join(root, 'out/backend/index.cjs')
    try {
      await access(entry)
    } catch {
      continue
    }
    return {
      command: process.execPath,
      entry,
      development: root !== here
    }
  }
  const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
  // Only the registry entry package opts in; desktop launchers and source checkouts keep their paths.
  if (manifest.optionalDependencies?.[runtimePackageName({ id: 'darwin-arm64' })]) {
    const name = runtimePackageName(currentRuntimeTarget())
    let packageFile
    try {
      packageFile = createRequire(import.meta.url).resolve(`${name}/package.json`)
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
      if (!required) return { development: false }
      throw new Error(
        `Missing ${name}@${manifest.version}. Reinstall @aipoch/open-science with npm --include=optional.`
      )
    }
    const native = JSON.parse(await readFile(packageFile, 'utf8'))
    if (native.name !== name || native.version !== manifest.version)
      throw new Error(
        `Open-Science native package version mismatch: expected ${name}@${manifest.version}. Reinstall the package.`
      )
    const entry = join(dirname(packageFile), 'out/backend/index.cjs')
    await access(entry)
    return { command: process.execPath, entry, development: false }
  }
  if (!required) {
    // Profile initialization/offline login also work with a lightweight CLI or desktop launcher.
    // Only a real source checkout selects the development profile without a built backend.
    try {
      await access(join(here, '../../src/main/node-entry.ts'))
      return { development: true }
    } catch {
      return { development: false }
    }
  }
  throw new Error(
    'The standalone Node backend is missing. Install the standalone Open-Science package, or run npm run build:backend in the repository.'
  )
}
