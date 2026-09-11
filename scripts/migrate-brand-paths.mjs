#!/usr/bin/env node
// The installed application invokes the same dependency-free core before opening its writers.
import { main } from '../resources/brand-migration/cli.mjs'
main().catch((error) => {
  console.error(`Brand migration stopped: ${error.message}`)
  process.exitCode = 1
})
