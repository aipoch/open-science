import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function run([command, ...args]) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export function setup({ importMetaUrl, requirePlatform, srcDirName }) {
  if (requirePlatform && process.platform !== requirePlatform) {
    throw new Error(
      `This helper must be built on ${requirePlatform}; current platform is ${process.platform}`,
    )
  }

  const outputDirectory = dirname(fileURLToPath(importMetaUrl))
  const sourceDirectory = join(outputDirectory, '..', srcDirName)
  if (!existsSync(sourceDirectory)) {
    throw new Error(`Helper source directory not found: ${sourceDirectory}`)
  }
  mkdirSync(outputDirectory, { recursive: true })
  return { SRC: sourceDirectory, OUT: outputDirectory }
}
