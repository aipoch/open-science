/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verificationPlanFromArguments } from './package-verification-plan.mjs'

// These are consumer scenarios, not another dependency graph. Prerequisites come from the registry.
export const verificationFamilies = [
  {
    script: 'check:connector-packages',
    packages: ['connector-core', 'connector-builtins', 'connector-mcp-client']
  },
  { script: 'check:diagnostics-package', packages: ['diagnostics'] },
  { script: 'check:environment-package', packages: ['environment'] },
  { script: 'check:compute-package', packages: ['compute'] },
  {
    script: 'check:notebook-packages',
    packages: ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis']
  },
  { script: 'verify:package', prefix: 'packages/skills', packages: ['skills'] },
  {
    script: 'check:package-isolation',
    packages: [
      'pdf-structure',
      'pdf-translation',
      'literature-citations',
      'journal-catalog',
      'literature-discovery'
    ]
  }
]

export function verificationCommands(plan) {
  const selected = plan.tests.map((root) => root.slice('packages/'.length))
  const unknown = selected.filter(
    (name) => !verificationFamilies.some((family) => family.packages.includes(name))
  )
  if (unknown.length)
    throw new Error(`No installed-consumer verification registered for: ${unknown.join(', ')}`)
  return verificationFamilies.flatMap((family) => {
    const packages = selected.filter((name) => family.packages.includes(name))
    return packages.length ? [{ ...family, packages }] : []
  })
}

export async function checkPackages(args = process.argv.slice(2)) {
  const plan = verificationPlanFromArguments(args)
  const commands = verificationCommands(plan)
  console.log(JSON.stringify({ ...plan, consumers: commands }, null, 2))
  if (args.includes('--explain')) return
  if (!process.env.npm_execpath) throw new Error('Run through npm run check:packages')
  const output = resolve(
    args.find((arg) => arg.startsWith('--output='))?.slice(9) ??
      'test-results/package-verification.json'
  )
  const report = { node: process.version, plan, runs: [] }
  await mkdir(dirname(output), { recursive: true })
  for (const command of commands) {
    const started = performance.now()
    const exitCode = await new Promise((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          process.env.npm_execpath,
          ...(command.prefix ? ['--prefix', command.prefix] : []),
          'run',
          command.script,
          '--',
          `--packages=${command.packages.join(',')}`,
          ...(args.includes('--offline') ? ['--offline'] : [])
        ],
        { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' }
      )
      child.once('error', reject)
      child.once('exit', (code) => done(code ?? 1))
    })
    report.runs.push({
      script: command.script,
      packages: command.packages,
      durationMs: performance.now() - started,
      exitCode
    })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    if (exitCode !== 0) process.exitCode = 1
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await checkPackages()
