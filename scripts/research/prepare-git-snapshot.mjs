/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { devNull } from 'node:os'

const MAX_BYTES = 128 * 1024 * 1024
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.venv',
  'node_modules',
  '__pycache__',
  'coverage',
  'reports'
])

const digest = (value) => createHash('sha256').update(value).digest('hex')

function git(repository, args, options = {}) {
  // Plumbing commands read committed objects, never checkout files, filters, hooks or .env.
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]
    )
  )
  return execFileSync('git', ['--no-replace-objects', '-C', repository, ...args], {
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0'
    },
    maxBuffer: MAX_BYTES + 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options
  })
}

function portablePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    /[\\:*?"<>|]/u.test(value) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    value.normalize('NFC') !== value ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)
      )
  ) {
    throw new Error(`Non-portable Git path: ${JSON.stringify(value)}`)
  }
  return value
}

function exclusionReason(path, extra) {
  if (path.split('/').some((part) => /^\.env/iu.test(part))) return 'environment-file'
  if (path.split('/').some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase())))
    return 'generated-or-local-data'
  if (extra.some((entry) => path === entry || path.startsWith(`${entry}/`)))
    return 'explicit-exclusion'
  return null
}

function tarName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    const prefix = path.slice(0, at)
    const name = path.slice(at + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`Path exceeds portable ustar limits: ${path}`)
}

function archive(entries) {
  const chunks = []
  for (const entry of entries) {
    const { name, prefix } = tarName(`project/${entry.path}`)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    const octal = (number, offset, length) => {
      const value = number.toString(8)
      if (value.length > length - 1) throw new Error('ustar numeric field overflow')
      header.write(value.padStart(length - 1, '0') + '\0', offset, length, 'ascii')
    }
    octal(entry.mode === '100755' ? 0o755 : 0o644, 100, 8)
    octal(0, 108, 8)
    octal(0, 116, 8)
    octal(entry.content.length, 124, 12)
    octal(0, 136, 12)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    header.write(prefix, 345, 155, 'utf8')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    chunks.push(header, entry.content, Buffer.alloc((512 - (entry.content.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

async function futureRealpath(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await futureRealpath(parent), relative(parent, path))
  }
}

/** Produce an immutable, portable candidate source publication without reading the worktree. */
export async function prepareGitSnapshot({
  repository,
  commit,
  outputDirectory,
  sourceUrl,
  excludePaths = []
}) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '')) {
    throw new Error('A full lowercase commit ID is required; moving refs are not accepted')
  }
  const url = new URL(sourceUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Source URL must be an HTTPS repository URL without credentials, query or fragment'
    )
  }
  if (!Array.isArray(excludePaths)) throw new Error('excludePaths must be an array')
  const exclusions = excludePaths.map(portablePath).sort()
  const repo = await realpath(repository)
  const bare =
    git(repo, ['rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim() === 'true'
  const sourceRoot = await realpath(
    git(repo, ['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
  )
  const output = await futureRealpath(resolve(outputDirectory))
  const outputRelative = relative(sourceRoot, output)
  if (!outputRelative || (!isAbsolute(outputRelative) && !outputRelative.startsWith(`..${sep}`))) {
    throw new Error('Snapshot output must be outside the source repository')
  }
  const actual = git(repo, ['rev-parse', '--verify', `${commit}^{commit}`], {
    encoding: 'utf8'
  }).trim()
  if (actual !== commit) throw new Error('Requested object is not that exact commit')
  const tree = git(repo, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim()
  const listing = git(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit])
  if (!Buffer.from(listing.toString('utf8')).equals(listing)) {
    throw new Error('Git paths must use valid UTF-8')
  }
  const entries = []
  const excludedFiles = []
  const names = new Map()
  let totalBytes = 0
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\s+([\d-]+)\t([\s\S]+)$/u.exec(record)
    if (!match) throw new Error('Unexpected git ls-tree output')
    const [, mode, type, object, size, rawPath] = match
    const path = portablePath(rawPath)
    const reason = exclusionReason(path, exclusions)
    if (reason) {
      excludedFiles.push({ path, reason })
      continue
    }
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw new Error(`Unsupported Git entry (links and submodules are not materialized): ${path}`)
    }
    // Implicit directories also share names on case-insensitive recipients.
    // Checking only whole file paths misses a/one + A/two.
    const segments = path.split('/')
    for (let count = 1; count <= segments.length; count++) {
      const prefix = segments.slice(0, count).join('/')
      const folded = prefix.toLowerCase()
      const existing = names.get(folded)
      if (existing !== undefined && existing !== prefix) {
        throw new Error(`Case-colliding Git path: ${path}`)
      }
      names.set(folded, prefix)
    }
    totalBytes += Number(size)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BYTES) {
      throw new Error('Source snapshot exceeds 128 MiB; select a smaller publication scope')
    }
    entries.push({ path, mode, object, sizeBytes: Number(size) })
    if (entries.length > 10_000) throw new Error('Source snapshot exceeds 10000 files')
  }
  if (!entries.length) throw new Error('No source files remain after exclusions')
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  const blobs = git(repo, ['cat-file', '--batch'], {
    input: entries.map((entry) => entry.object).join('\n') + '\n'
  })
  let offset = 0
  for (const entry of entries) {
    const end = blobs.indexOf(10, offset)
    const header = blobs.subarray(offset, end).toString('ascii')
    if (end < 0 || header !== `${entry.object} blob ${entry.sizeBytes}`) {
      throw new Error('Unexpected git cat-file response')
    }
    offset = end + 1
    entry.content = blobs.subarray(offset, offset + entry.sizeBytes)
    if (entry.content.length !== entry.sizeBytes || blobs[offset + entry.sizeBytes] !== 10) {
      throw new Error('Truncated git blob')
    }
    entry.sha256 = digest(entry.content)
    offset += entry.sizeBytes + 1
  }
  if (offset !== blobs.length) throw new Error('Unexpected trailing git object data')
  const payload = archive(entries)
  const manifest = {
    format: 'open-science-git-source-snapshot',
    version: 1,
    source: { repository: url.href, commit, tree },
    archive: {
      filename: 'source.tar.gz',
      format: 'tar.gz',
      root: 'project',
      sha256: digest(payload),
      sizeBytes: payload.length
    },
    fileCount: entries.length,
    totalFileBytes: totalBytes,
    files: entries.map(({ path, mode, sizeBytes, sha256 }) => ({ path, mode, sizeBytes, sha256 })),
    exclusions: {
      policy: 'environment-and-generated-data-v1',
      explicitPaths: exclusions,
      files: excludedFiles
    },
    licenseEvidence: entries
      .filter((entry) => /(?:^|\/)(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.path))
      .map(({ path, sha256 }) => ({ path, sha256 })),
    review: {
      status: 'publication-review-required',
      note: 'A committed-file snapshot is not a credential scan, license grant or proof of a historical runtime. No project code was executed.'
    }
  }
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  try {
    await writeFile(join(output, 'source.tar.gz'), payload, { flag: 'wx', mode: 0o600 })
    await writeFile(
      join(output, 'source-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      {
        flag: 'wx',
        mode: 0o600
      }
    )
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  try {
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i += 2) {
      const key = {
        '--repository': 'repository',
        '--commit': 'commit',
        '--output': 'outputDirectory',
        '--source-url': 'sourceUrl'
      }[args[i]]
      if (!key || !args[i + 1] || options[key]) throw new Error('Invalid or duplicate argument')
      options[key] = args[i + 1]
    }
    if (Object.keys(options).length !== 4) {
      throw new Error(
        'Required: --repository PATH --commit FULL_ID --output NEW_DIRECTORY --source-url HTTPS_URL'
      )
    }
    const result = await prepareGitSnapshot(options)
    console.log(
      JSON.stringify(
        { source: result.source, archive: result.archive, fileCount: result.fileCount },
        null,
        2
      )
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
