/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dirname, '..')

export function packageBuildProjects(root = repositoryRoot) {
  const solution = ts.readConfigFile(join(root, 'tsconfig.packages.json'), ts.sys.readFile)
  if (solution.error)
    throw new Error(ts.flattenDiagnosticMessageText(solution.error.messageText, '\n'))
  return solution.config.references.map(({ path }) => {
    const configPath = resolve(root, path)
    const config = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (error) => {
          throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        }
      }
    )
    if (config.errors.length)
      throw new Error(
        ts.formatDiagnostics(config.errors, {
          getCanonicalFileName: (file) => file,
          getCurrentDirectory: () => root,
          getNewLine: () => '\n'
        })
      )
    return {
      root: dirname(configPath),
      configPath,
      config,
      outputs: new Set(
        config.fileNames
          .flatMap((file) => ts.getOutputFileNames(config, file, !ts.sys.useCaseSensitiveFileNames))
          .map((file) => resolve(file))
      )
    }
  })
}

// Build mode trusts its metadata even when an individual emitted JS file has been deleted.
// Invalidate that project's metadata, then let TypeScript own compilation and dependency order.
export async function buildDevPackages({
  root = repositoryRoot,
  log = console.log,
  force = false
} = {}) {
  const projects = packageBuildProjects(root)
  for (const project of projects) {
    if ([...project.outputs].some((file) => !existsSync(file)))
      rmSync(project.config.options.tsBuildInfoFile, { force: true })
  }
  const start = performance.now()
  await new Promise((resolveBuild, reject) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '--build',
        join(root, 'tsconfig.packages.json'),
        '--stopBuildOnErrors',
        ...(force ? ['--force'] : [])
      ],
      { cwd: root, stdio: 'inherit' }
    )
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0 ? resolveBuild() : reject(new Error(`Package build failed (${signal ?? code}).`))
    )
  })
  // TypeScript does not delete outputs of removed/renamed source files. Only these configs own dist.
  for (const project of packageBuildProjects(root)) {
    const out = project.config.options.outDir
    if (!existsSync(out)) continue
    for (const file of readdirSync(out, { recursive: true })) {
      if (/\.(?:[cm]?js|d\.[cm]?ts)(?:\.map)?$/.test(file) && !project.outputs.has(join(out, file)))
        rmSync(join(out, file))
    }
  }
  log(
    `Development packages ready (${((performance.now() - start) / 1000).toFixed(2)}s, incremental).`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDevPackages()
}
