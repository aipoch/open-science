/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const DEFAULT_RUNS = 7
const LISTENING_MARKER = 'listening on'

const parseArguments = (argv) => {
  const options = { runs: DEFAULT_RUNS, label: 'startup', root: undefined, backend: undefined }
  for (const argument of argv) {
    if (argument.startsWith('--runs=')) options.runs = Number(argument.slice('--runs='.length))
    else if (argument.startsWith('--label=')) options.label = argument.slice('--label='.length)
    else if (argument.startsWith('--root=')) options.root = argument.slice('--root='.length)
    else if (argument.startsWith('--backend='))
      options.backend = argument.slice('--backend='.length)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 2)
    throw new Error('--runs must be an integer greater than or equal to 2.')
  return options
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

const waitForExit = (child) =>
  new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit()
      return
    }
    child.once('close', resolveExit)
  })

const measureRun = ({ backend, configRoot, installationStateRoot }) =>
  new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now()
    const child = spawn(process.execPath, [backend, '--development', '--serve=0'], {
      cwd: dirname(dirname(dirname(backend))),
      env: {
        ...process.env,
        OPEN_SCIENCE_CONFIG_ROOT: configRoot,
        OPEN_SCIENCE_E2E_STORAGE_ROOT: dirname(installationStateRoot),
        OPEN_SCIENCE_INSTALLATION_STATE_ROOT: installationStateRoot
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      rejectRun(new Error(`Backend did not become ready within 60 seconds.\n${stderr}`))
    }, 60_000)
    const finish = async () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const elapsedMs = Math.round(performance.now() - startedAt)
      child.kill()
      await waitForExit(child)
      resolveRun({ elapsedMs, stdout, stderr })
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.includes(LISTENING_MARKER)) void finish()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectRun(
        new Error(
          `Backend exited before becoming ready (code=${code ?? 'unknown'}, signal=${signal ?? 'none'}).\n${stderr}`
        )
      )
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectRun(error)
    })
  })

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const backend = resolve(options.backend ?? 'out/backend/index.cjs')
  if (!existsSync(backend)) throw new Error(`Backend bundle not found: ${backend}`)
  const root = resolve(options.root ?? (await mkdtemp(join(tmpdir(), 'open-science-startup-'))))
  const configRoot = join(root, 'config')
  const installationStateRoot = join(root, 'installations')
  await mkdir(configRoot, { recursive: true })
  await mkdir(installationStateRoot, { recursive: true })
  const samples = []
  try {
    for (let index = 0; index < options.runs; index += 1) {
      const result = await measureRun({ backend, configRoot, installationStateRoot })
      samples.push(result.elapsedMs)
      process.stdout.write(
        `${options.label} run ${index + 1}/${options.runs}: ${result.elapsedMs} ms\n`
      )
    }
    const warmSamples = samples.slice(1)
    process.stdout.write(
      `${JSON.stringify(
        {
          label: options.label,
          backend,
          runs: samples.length,
          samples,
          first: samples[0],
          warmMedian: median(warmSamples),
          warmP95: percentile(warmSamples, 0.95)
        },
        null,
        2
      )}\n`
    )
  } finally {
    if (!options.root) await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
