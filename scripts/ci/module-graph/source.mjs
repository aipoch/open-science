/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Repository files as immutable inputs: Git snapshots or the working tree, never executed.
export function isSourcePath(path) {
  return /\.(?:[cm]?[jt]sx?|json)$/.test(path)
}

// Read immutable Git objects, never materialize or execute candidate code. A bounded
// batch also avoids one subprocess per dependency when inspecting a renderer cone.
export function sourceSnapshot(revision, cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 128 * 1024 * 1024 })
  const entries = new Map(
    git('ls-tree', '-r', '-z', revision)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [metadata, path] = entry.split('\t')
        const [mode, type, oid] = metadata.split(' ')
        return [path, { mode, type, oid }]
      })
  )
  const ids = [
    ...new Set(
      [...entries]
        .filter(([path, entry]) => isSourcePath(path) && /^100(?:644|755)$/.test(entry.mode))
        .map(([, entry]) => entry.oid)
    )
  ]
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd,
    input: ids.join('\n') + '\n',
    maxBuffer: 128 * 1024 * 1024
  })
  const contents = new Map()
  let offset = 0
  for (const oid of ids) {
    const newline = batch.indexOf(10, offset)
    const [actual, type, sizeText] = batch.subarray(offset, newline).toString('utf8').split(' ')
    const size = Number(sizeText)
    if (actual !== oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0)
      throw Error('Incomplete Git source snapshot')
    offset = newline + 1
    if (offset + size >= batch.length) throw Error('Truncated Git source snapshot')
    contents.set(oid, batch.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  const read = (path) => {
    const entry = entries.get(path)
    return entry && /^100(?:644|755)$/.test(entry.mode) ? contents.get(entry.oid) : undefined
  }
  return { files: new Set(entries.keys()), read }
}

export function workingTreeSource(cwd = process.cwd()) {
  const files = new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
      .split('\0')
      .filter((path) => path && existsSync(resolve(cwd, path)))
  )
  return {
    files,
    read: (path) => {
      const full = resolve(cwd, path)
      return files.has(path) && lstatSync(full).isFile() ? readFileSync(full, 'utf8') : undefined
    }
  }
}
