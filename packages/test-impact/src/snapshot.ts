import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { assertPortablePaths, isInside } from './paths.js'

export interface SourceSnapshot {
  parent: string
  root: string
  revision: string
  files: Set<string>
}

// Bound memory before reading blobs; exceeding this limit is an error, never a partial graph.
const maxBytes = 256 * 1024 * 1024
export async function withSourceSnapshot<T>(
  repository: string,
  revision: string,
  operation: (snapshot: SourceSnapshot) => Promise<T>
): Promise<T> {
  const git = (...args: string[]): Buffer =>
    execFileSync('git', ['--no-replace-objects', ...args], {
      cwd: repository,
      maxBuffer: maxBytes + 16 * 1024 * 1024,
      timeout: 120000
    })
  const commit = git('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`)
    .toString('utf8')
    .trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Invalid resolved commit')
  const tree = new TextDecoder('utf8', { fatal: true }).decode(
    git('ls-tree', '-r', '-l', '-z', '--full-tree', commit)
  )
  const entries = tree
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t')
      if (tab < 0) throw new Error('Invalid Git tree record')
      const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/)
      if (!/^100(?:644|755)$/.test(mode) || type !== 'blob')
        throw new Error(`Unsupported snapshot entry: ${record.slice(tab + 1)} (${mode})`)
      return { file: record.slice(tab + 1), oid, size: Number(size) }
    })
  assertPortablePaths(entries.map((entry) => entry.file))
  if (
    entries.some((entry) => !Number.isSafeInteger(entry.size) || entry.size < 0) ||
    entries.reduce((sum, entry) => sum + entry.size, 0) > maxBytes
  )
    throw new Error('Snapshot exceeds 256 MiB byte budget')
  const temporary = mkdtempSync(join(tmpdir(), 'test-impact-'))
  try {
    // On macOS /var and /private/var must have one identity for both the resolver and child cwd.
    const parent = realpathSync(temporary)
    const root = join(parent, 'source')
    mkdirSync(root)
    const ids = [...new Set(entries.map((entry) => entry.oid))]
    if (ids.length) {
      const batch = execFileSync('git', ['--no-replace-objects', 'cat-file', '--batch'], {
        cwd: repository,
        input: ids.join('\n') + '\n',
        maxBuffer: maxBytes + 16 * 1024 * 1024,
        timeout: 120000
      })
      const contents = new Map<string, Buffer>()
      let offset = 0
      for (const oid of ids) {
        const newline = batch.indexOf(10, offset)
        if (newline < 0) throw new Error('Missing Git blob header')
        const [actual, type, sizeText] = batch.subarray(offset, newline).toString('utf8').split(' ')
        const size = Number(sizeText)
        offset = newline + 1
        if (
          actual !== oid ||
          type !== 'blob' ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          offset + size >= batch.length ||
          batch[offset + size] !== 10
        )
          throw new Error('Invalid Git blob batch')
        contents.set(oid, batch.subarray(offset, offset + size))
        offset += size + 1
      }
      if (offset !== batch.length) throw new Error('Unexpected Git batch suffix')
      for (const entry of entries) {
        const target = resolve(root, ...entry.file.split('/'))
        if (!isInside(root, target)) throw new Error('Snapshot path escapes root')
        const content = contents.get(entry.oid)
        if (!content || content.length !== entry.size) throw new Error('Git blob size mismatch')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
      }
    }
    return await operation({
      parent,
      root,
      revision: commit,
      files: new Set(entries.map((entry) => entry.file))
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
