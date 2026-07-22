#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@aipoch/open-science'

export const validateNpmReleaseTag = (tag, manifest) => {
  if (manifest?.name !== PACKAGE_NAME) {
    throw new Error(
      `Expected package name ${PACKAGE_NAME}, received ${manifest?.name ?? 'missing'}.`
    )
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('The npm package version is missing.')
  }
  const expectedTag = `npm-v${manifest.version}`
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag || 'missing'} does not match ${expectedTag}.`)
  }
  return { name: manifest.name, version: manifest.version, tag }
}

const main = async () => {
  const tag = process.argv[2] ?? ''
  const packagePath = resolve(
    fileURLToPath(new URL('..', import.meta.url)),
    'packages/open-science/package.json'
  )
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  const result = validateNpmReleaseTag(tag, manifest)
  console.log(`Validated ${result.name}@${result.version} for tag ${result.tag}.`)
}

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
