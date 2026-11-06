import { prepareMacRecoveryProcesses } from './mac-installation-processes'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Bundled into the signed stable launcher; executed only with a Node binary from an independently
// verified staged target. The native parent retains the original installation's owner lock and
// publishes the shared save deadline before invoking this existing verified shutdown path.
async function main(): Promise<void> {
  const resolver = createRequire(__filename)
  const native = resolver('@aipoch/process-tree-native') as Record<string, unknown>
  for (const name of [
    'listDarwinProcesses',
    'getDarwinProcess',
    'getDarwinProcessExecutable',
    'getDarwinProcessArguments',
    'signalDarwinProcess',
    'listDarwinInstallationMappings'
  ])
    if (typeof native[name] !== 'function')
      throw Object.assign(new Error('The verified target native API is incompatible.'), {
        stage: 'native-api-incompatible'
      })
  process.stdout.write(
    JSON.stringify({
      stage: 'verified-target-control-loaded',
      nodeArchitecture: process.arch,
      addonSha256: createHash('sha256')
        .update(
          readFileSync(
            resolver.resolve('@aipoch/process-tree-native/build/Release/process_tree_native.node')
          )
        )
        .digest('hex')
    }) + '\n'
  )
  const [root, deadline, parent] = process.argv.slice(2)
  const deadlineAt = Number(deadline)
  const parentPid = Number(parent)
  if (
    !root ||
    !Number.isSafeInteger(deadlineAt) ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0
  )
    throw new Error('Invalid native recovery shutdown capability.')
  const result = await prepareMacRecoveryProcesses(root, {
    deadlineAt,
    excludedProcessIds: [parentPid],
    signal: AbortSignal.timeout(60_000)
  })
  process.stdout.write(JSON.stringify({ stage: 'owned-processes-released', ...result }) + '\n')
}

void main().catch((error: unknown) => {
  // Only bounded stage diagnostics; no argv, environment, credentials or scientific data.
  const stage =
    error && typeof error === 'object' && 'stage' in error ? error.stage : 'recovery-close-failed'
  process.stderr.write(JSON.stringify({ stage }) + '\n')
  process.exitCode = 1
})
