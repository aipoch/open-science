#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone CLI. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function parseSmokeOptions(args, env) {
  const values = new Map()
  for (const argument of args) {
    const match =
      /^(--live|--reasoning-split|--compact|--output|--endpoint|--model)(?:=(.*))?$/.exec(argument)
    if (
      !match ||
      values.has(match[1]) ||
      (['--live', '--reasoning-split', '--compact'].includes(match[1])
        ? match[2] !== undefined
        : !match[2])
    )
      throw new Error('Invalid smoke options')
    values.set(match[1], match[2] ?? true)
  }
  const live = values.has('--live')
  const output = values.get('--output')
  if (!output) throw new Error('Provide --output=<new-directory>')
  if (!live && (values.has('--endpoint') || values.has('--model')))
    throw new Error('Model selection requires --live')
  if (
    live &&
    (!values.get('--endpoint') ||
      !values.get('--model')?.trim() ||
      !env.OPEN_SCIENCE_HARNESS_API_KEY?.trim())
  )
    throw new Error('Live mode requires endpoint, model and OPEN_SCIENCE_HARNESS_API_KEY')
  const endpoint = live ? values.get('--endpoint') : 'https://fixture.invalid'
  const url = new URL(endpoint)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTP(S) provider root without embedded credentials, query or fragment')
  return {
    mode: live ? 'live' : 'fixture',
    output: resolve(output),
    endpoint,
    reasoningSplit: values.has('--reasoning-split'),
    compact: values.has('--compact'),
    model: live ? values.get('--model').trim() : 'fixture-model',
    key: live ? env.OPEN_SCIENCE_HARNESS_API_KEY : 'fixture-key'
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseSmokeOptions(args, env)
  const cache = join(root, 'node_modules', '.cache')
  await mkdir(cache, { recursive: true })
  const bundleDirectory = await mkdtemp(join(cache, 'harness-smoke-'))
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const outfile = join(bundleDirectory, 'runner.cjs')
    await build({
      entryPoints: [join(root, 'scripts/agent-harness-smoke-runner.mjs')],
      outfile,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      loader: { '.md': 'text' },
      define: { 'import.meta.url': '__entryUrl', 'import.meta.dirname': '__dirname' },
      banner: { js: 'const __entryUrl = require("node:url").pathToFileURL(__filename).href;' },
      logLevel: 'silent'
    })
    const { runHarnessSmoke } = createRequire(import.meta.url)(outfile)
    const report = await runHarnessSmoke(
      options,
      AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)])
    )
    console.log(
      JSON.stringify({
        status: report.status,
        mode: report.mode,
        report: join(options.output, 'report.json')
      })
    )
    return report.status === 'passed' ? 0 : report.status === 'interrupted' ? 130 : 1
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    await rm(bundleDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    () => {
      console.error(
        'Harness smoke failed. Check explicit options and output-directory availability; existing request evidence is preserved.'
      )
      process.exitCode = 1
    }
  )
}
