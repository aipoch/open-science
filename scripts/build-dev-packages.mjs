/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  force = false,
  clean = false,
  packages
} = {}) {
  const graph = packageBuildProjects(root)
  const selected = new Set()
  const visited = new Set()
  const include = (project) => {
    if (!project) throw new Error('Unknown package build target')
    if (visited.has(project)) return
    visited.add(project)
    for (const ref of project.config.projectReferences ?? [])
      include(graph.find((candidate) => candidate.configPath === resolve(ref.path)))
    selected.add(project)
  }
  if (packages)
    for (const name of packages) include(graph.find((p) => p.root === join(root, 'packages', name)))
  else graph.forEach(include)
  const projects = [...selected]
  for (const project of projects) {
    const out = project.config.options.outDir
    if (clean) {
      rmSync(out, { recursive: true, force: true })
      rmSync(project.config.options.tsBuildInfoFile, { force: true })
    } else if (existsSync(out)) {
      // Remove stale emit before compilation: downstream resolution must not see deleted modules.
      for (const file of readdirSync(out, { recursive: true })) {
        if (
          /\.(?:[cm]?js|d\.[cm]?ts)(?:\.map)?$/.test(file) &&
          !project.outputs.has(join(out, file))
        )
          rmSync(join(out, file))
      }
    }
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
        ...projects.map((project) => project.configPath),
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
  // Packages own non-TypeScript output. Run their declared step after successful compilation,
  // including incremental builds that may need to repair missing resources.
  for (const project of projects) {
    const manifest = JSON.parse(readFileSync(join(project.root, 'package.json'), 'utf8'))
    if (!manifest.scripts?.['build:assets']) continue
    const npmCli = process.env.npm_execpath
    await new Promise((resolveAssets, reject) => {
      const child = spawn(
        npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
        [...(npmCli ? [npmCli] : []), 'run', 'build:assets'],
        {
          cwd: project.root,
          stdio: 'inherit',
          shell: !npmCli && process.platform === 'win32'
        }
      )
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        code === 0
          ? resolveAssets()
          : reject(new Error(`Package assets failed for ${manifest.name} (${signal ?? code}).`))
      )
    })
  }
  log(
    `Packages ready (${((performance.now() - start) / 1000).toFixed(2)}s, ${clean ? 'clean' : 'incremental'}).`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDevPackages({
    clean: process.argv.includes('--clean'),
    force: process.argv.includes('--force'),
    packages: process.argv
      .find((arg) => arg.startsWith('--packages='))
      ?.slice(11)
      .split(',')
  })
}
