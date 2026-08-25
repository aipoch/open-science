/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_SMOKE_PLATFORMS = [
  { name: 'macos-arm64', os: 'macos-26', platform: 'mac' },
  { name: 'macos-x64', os: 'macos-26-intel', platform: 'mac' },
  { name: 'linux-x64', os: 'ubuntu-latest', platform: 'linux' },
  { name: 'windows-x64', os: 'windows-latest', platform: 'win' }
]

export function resolvePackageSmokeMatrix(platformName = '') {
  const trimmed = platformName.trim()
  const include =
    trimmed === '' || trimmed === 'all'
      ? PACKAGE_SMOKE_PLATFORMS
      : PACKAGE_SMOKE_PLATFORMS.filter((row) => row.name === trimmed)
  if (include.length === 0) {
    throw new Error(`unknown platform_name '${platformName}'`)
  }
  return JSON.stringify({ include })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(resolvePackageSmokeMatrix(process.env.PLATFORM_NAME ?? ''))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`::error::${message}\n`)
    process.exit(1)
  }
}
