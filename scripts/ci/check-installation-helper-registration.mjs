/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { installationHelperFlags } = require(
  resolve(root, 'packages/open-science/installation-startup.cjs')
)

const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')
const unique = (values) => [...new Set(values)]
const sorted = (values) => [...values].sort()
const difference = (left, right) => left.filter((value) => !right.includes(value))

function flagDefinitions(source, namePattern) {
  return [
    ...source.matchAll(
      new RegExp('export\\s+const\\s+' + namePattern + '\\s*=\\s*([\'"])([^\'"]+)\\1', 'g')
    )
  ].map((match) => ({ name: match[0], value: match[2] }))
}

const helperDefinitionSources = [
  ['src/main/harness-acp/config.ts', 'HARNESS_ACP_ARG'],
  ['src/main/mcp-server-args.ts', '[A-Z][A-Z0-9_]*_ARG']
]
const sourceFlags = unique(
  helperDefinitionSources.flatMap(([relativePath, namePattern]) =>
    flagDefinitions(read(relativePath), namePattern).map(({ value }) => value)
  )
)

const runtimeHelperPath = resolve(root, 'src/main/runtime-helper.ts')
const runtimeHelperSource = readFileSync(runtimeHelperPath, 'utf8')
const importedFlagDefinitions = new Map()
for (const match of runtimeHelperSource.matchAll(
  /import\s*{([\s\S]*?)}\s*from\s*['"]([^'"]+)['"]/g
)) {
  const importNames = match[1]
    .split(',')
    .map((part) =>
      part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
    )
    .filter((name) => name && /_ARG$/.test(name))
  if (importNames.length === 0) continue
  if (!match[2].startsWith('.')) continue
  const importedPath = resolve(dirname(runtimeHelperPath), match[2])
  const sourcePath = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
    .map((extension) => `${importedPath}${extension}`)
    .find((candidate) => existsSync(candidate))
  if (!sourcePath) throw new Error(`Cannot resolve helper flag import ${match[2]}`)
  const source = readFileSync(sourcePath, 'utf8')
  for (const name of importNames) {
    const definition = flagDefinitions(source, name)[0]
    if (!definition) throw new Error(`Cannot resolve helper flag definition ${name}`)
    importedFlagDefinitions.set(name, definition.value)
  }
}

const referencedFlags = unique(
  [...runtimeHelperSource.matchAll(/argv\.includes\(\s*([A-Z][A-Z0-9_]*_ARG)\s*\)/g)].map(
    (match) => {
      const value = importedFlagDefinitions.get(match[1])
      if (!value) throw new Error(`Runtime helper references unresolved flag ${match[1]}`)
      return value
    }
  )
)
const literalFlags = unique(
  [
    ...runtimeHelperSource.matchAll(/(['"`])(--(?:internal-agent|open-science)-[A-Za-z0-9-]+)\1/g)
  ].map((match) => match[2])
)
const runtimeFlags = unique([...referencedFlags, ...literalFlags])
const installationFlags = [...installationHelperFlags]

const duplicateInstallationFlags = installationFlags.filter(
  (flag, index) => installationFlags.indexOf(flag) !== index
)
const missingFromInstallation = difference(sourceFlags, installationFlags)
const extraInInstallation = difference(installationFlags, sourceFlags)
const missingFromRuntime = difference(sourceFlags, runtimeFlags)
const extraInRuntime = difference(runtimeFlags, sourceFlags)

if (
  duplicateInstallationFlags.length > 0 ||
  missingFromInstallation.length > 0 ||
  extraInInstallation.length > 0 ||
  missingFromRuntime.length > 0 ||
  extraInRuntime.length > 0 ||
  sorted(sourceFlags).join('\n') !== sorted(runtimeFlags).join('\n')
) {
  console.error('Installation helper registration mismatch')
  if (duplicateInstallationFlags.length > 0)
    console.error(`duplicate installation flags: ${unique(duplicateInstallationFlags).join(', ')}`)
  if (missingFromInstallation.length > 0)
    console.error(`missing from installationHelperFlags: ${missingFromInstallation.join(', ')}`)
  if (extraInInstallation.length > 0)
    console.error(`not declared by helper sources: ${extraInInstallation.join(', ')}`)
  if (missingFromRuntime.length > 0)
    console.error(`declared but not dispatched by runtime-helper: ${missingFromRuntime.join(', ')}`)
  if (extraInRuntime.length > 0)
    console.error(`runtime-helper flags without a helper definition: ${extraInRuntime.join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`Installation helper registration is complete for ${installationFlags.length} flags.`)
}
