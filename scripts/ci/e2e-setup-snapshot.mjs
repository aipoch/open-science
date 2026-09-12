/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  access,
  appendFile,
  lstat,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

const archiveName = 'setup.tar.gz'
const manifestName = 'setup.json'
const dependenciesArchiveName = 'dependencies.tar.gz'
const dependenciesManifestName = 'dependencies.json'

// npm's Windows junctions carry absolute producer paths. Archive the package targets and recreate
// only these lockfile-owned links in the consumer, while tar preserves other links and file modes.
export function localPackageLinks(lock) {
  return Object.entries(lock.packages)
    .filter(([, value]) => value.link)
    .map(([path, value]) => {
      if (
        !/^node_modules\/(?:@[\w.-]+\/)?[\w.-]+$/.test(path) ||
        !/^packages\/[\w-]+$/.test(value.resolved)
      ) {
        throw new Error(`Unsupported local package link: ${path} -> ${value.resolved}`)
      }
      return { path, target: value.resolved }
    })
}

export function validateIdentity(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`E2E setup ${key} mismatch`)
  }
}

async function identity(cwd, env) {
  if (!env.GITHUB_RUN_ID) throw new Error('E2E snapshots require GITHUB_RUN_ID')
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    runId: env.GITHUB_RUN_ID,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    lockHash: createHash('sha256')
      .update(await readFile(join(cwd, 'package-lock.json')))
      .digest('hex')
  }
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function tarProcess(args, cwd, env) {
  // Git Bash also ships tar; use the OS implementation consistently on Windows.
  const executable =
    process.platform === 'win32'
      ? join(env.SystemRoot ?? env.SYSTEMROOT, 'System32', 'tar.exe')
      : 'tar'
  const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] })
  const completed = new Promise((fulfill, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) fulfill()
      else reject(new Error(`tar exited with ${code}`))
    })
  })
  return { child, completed }
}

export async function packSnapshot(cwd, directory, env = process.env) {
  // The output must live outside the archived workspace paths (RUNNER_TEMP in CI).
  const metadata = await identity(cwd, env)
  const links = localPackageLinks(
    JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))
  )
  const paths = ['node_modules', 'out', ...links.map(({ target }) => target)]
  for (const path of paths) {
    if (!(await lstat(join(cwd, path))).isDirectory()) {
      throw new Error(`Snapshot input must be a real directory: ${path}`)
    }
  }
  await mkdir(directory, { recursive: true })
  const archive = join(directory, archiveName)
  const { child, completed } = tarProcess(
    ['-cf', '-', ...links.map(({ path }) => `--exclude=${path}`), ...paths],
    cwd,
    env
  )
  child.stdin.end()
  await Promise.all([
    completed,
    pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(archive, { flags: 'wx' }))
  ])
  await writeFile(
    join(directory, manifestName),
    JSON.stringify({ ...metadata, sha256: await digest(archive) }) + '\n',
    { flag: 'wx' }
  )
  return (await stat(archive)).size
}

async function packArchive(cwd, directory, env, { archiveName, manifestName, paths }) {
  const metadata = await identity(cwd, env)
  const links = localPackageLinks(
    JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))
  )
  for (const path of paths) {
    if (!(await lstat(join(cwd, path))).isDirectory()) {
      throw new Error(`Snapshot input must be a real directory: ${path}`)
    }
  }
  await mkdir(directory, { recursive: true })
  const archive = join(directory, archiveName)
  const { child, completed } = tarProcess(
    ['-cf', '-', ...links.map(({ path }) => `--exclude=${path}`), ...paths],
    cwd,
    env
  )
  child.stdin.end()
  await Promise.all([
    completed,
    pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(archive, { flags: 'wx' }))
  ])
  await writeFile(
    join(directory, manifestName),
    JSON.stringify({ ...metadata, sha256: await digest(archive) }) + '\n',
    { flag: 'wx' }
  )
  return (await stat(archive)).size
}

export async function packDependencies(cwd, directory, env = process.env) {
  const links = localPackageLinks(
    JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))
  )
  return packArchive(cwd, directory, env, {
    archiveName: dependenciesArchiveName,
    manifestName: dependenciesManifestName,
    paths: ['node_modules', ...links.map(({ target }) => target)]
  })
}

export async function restoreDependencies(cwd, directory, env = process.env) {
  const metadata = JSON.parse(await readFile(join(directory, dependenciesManifestName), 'utf8'))
  validateIdentity(metadata, await identity(cwd, env))
  const archive = join(directory, dependenciesArchiveName)
  if ((await digest(archive)) !== metadata.sha256)
    throw new Error('Dependencies snapshot checksum mismatch')
  try {
    await lstat(join(cwd, 'node_modules'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      const { child, completed } = tarProcess(['-xzf', archive], cwd, env)
      child.stdin.end()
      child.stdout.resume()
      await completed
      const links = localPackageLinks(
        JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))
      )
      for (const { path, target } of links) {
        const link = join(cwd, path)
        await mkdir(dirname(link), { recursive: true })
        await symlink(
          process.platform === 'win32'
            ? resolve(cwd, target)
            : relative(dirname(link), join(cwd, target)),
          link,
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
      return (await stat(archive)).size
    }
    throw error
  }
  throw new Error('Dependencies snapshot restore requires an absent node_modules')
}

export async function restoreSnapshot(cwd, directory, env = process.env) {
  const metadata = JSON.parse(await readFile(join(directory, manifestName), 'utf8'))
  validateIdentity(metadata, await identity(cwd, env))
  const archive = join(directory, archiveName)
  if ((await digest(archive)) !== metadata.sha256) throw new Error('E2E setup checksum mismatch')
  // Never extract through an existing dependency junction or combine two builds.
  for (const path of ['node_modules', 'out']) {
    try {
      await lstat(join(cwd, path))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    throw new Error(`E2E setup restore requires an absent ${path}`)
  }
  // GNU tar can exit successfully at the end marker before a pipe writer has sent the trailing
  // padding. Let tar own decompression so successful extraction cannot race Node's stdin pipeline.
  const { child, completed } = tarProcess(['-xzf', archive], cwd, env)
  child.stdin.end()
  child.stdout.resume()
  await completed
  const links = localPackageLinks(
    JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))
  )
  for (const { path, target } of links) {
    const link = join(cwd, path)
    await mkdir(dirname(link), { recursive: true })
    await symlink(
      process.platform === 'win32'
        ? resolve(cwd, target)
        : relative(dirname(link), join(cwd, target)),
      link,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  }
  return (await stat(archive)).size
}

export async function verifySnapshot(cwd, web = false) {
  const require = createRequire(join(cwd, 'package.json'))
  for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    await access(join(cwd, entry))
  }
  if (web) await access(join(cwd, 'out/web/index.html'))
  await access(require('electron'))
  if (typeof require('@prisma/client').PrismaClient !== 'function') {
    throw new Error('Snapshot has no generated Prisma client')
  }
  require('@aipoch/process-tree-native')
  require('@aipoch/safe-file-publisher-native')
  require.resolve('@playwright/test')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2)
  if (
    !['pack', 'restore', 'pack-dependencies', 'restore-dependencies'].includes(mode) ||
    !directory
  ) {
    throw new Error(
      'Usage: node scripts/ci/e2e-setup-snapshot.mjs <pack|restore|pack-dependencies|restore-dependencies> <directory>'
    )
  }
  const started = performance.now()
  const cwd = process.cwd()
  if (mode === 'pack') await verifySnapshot(cwd, process.platform === 'darwin')
  const operation =
    mode === 'pack'
      ? packSnapshot
      : mode === 'restore'
        ? restoreSnapshot
        : mode === 'pack-dependencies'
          ? packDependencies
          : restoreDependencies
  const bytes = await operation(cwd, resolve(directory))
  if (mode === 'restore') await verifySnapshot(cwd, process.platform === 'darwin')
  const summary = `E2E setup ${mode}: ${(bytes / 1024 / 1024).toFixed(1)} MiB, ${((performance.now() - started) / 1000).toFixed(1)} seconds`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${summary}\n`)
  }
}
