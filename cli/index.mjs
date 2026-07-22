#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { reportCliError, runCli } from '../packages/open-science/cli.mjs'

export * from '../packages/open-science/cli.mjs'

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  runCli().catch((error) => reportCliError(error))
}
