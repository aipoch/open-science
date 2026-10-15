#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { analyzeRevision } from './index.js'
import { parseConfiguration } from './configuration.js'

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      revision: { type: 'string' },
      config: { type: 'string' },
      help: { type: 'boolean' }
    },
    allowPositionals: false
  })
  if (values.help) {
    console.log(
      'test-impact --revision <commit> [--repository <directory>] [--config <trusted-json-file>]\nPrints diagnostic JSON to stdout. Does not select or skip tests.'
    )
  } else {
    if (!values.revision) throw new Error('--revision is required')
    const configuration = values.config
      ? parseConfiguration(JSON.parse(readFileSync(values.config, 'utf8')))
      : undefined
    const result = await analyzeRevision({
      repository: values.repository ?? process.cwd(),
      revision: values.revision,
      configuration
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
