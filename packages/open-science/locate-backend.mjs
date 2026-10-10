/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
