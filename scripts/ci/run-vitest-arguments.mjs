import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Restore argv inside this process so npm and the OS never transport the long test list.
const argumentFile = process.argv[2]
if (!argumentFile || process.argv.length !== 3) {
  throw new Error('Expected one Vitest argument file')
}
const arguments_ = JSON.parse(readFileSync(argumentFile, 'utf8'))
if (
  !Array.isArray(arguments_) ||
  arguments_[0] !== 'run' ||
  arguments_.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
) {
  throw new Error('Expected a Vitest run argument array')
}

// Use the installed package's declared CLI, including its option normalization and exit handling.
const manifestUrl = new URL(import.meta.resolve('vitest/package.json'))
const { bin } = JSON.parse(readFileSync(manifestUrl, 'utf8'))
const cliUrl = new URL(bin.vitest, manifestUrl)
process.argv = [process.execPath, fileURLToPath(cliUrl), ...arguments_]
await import(cliUrl.href)
