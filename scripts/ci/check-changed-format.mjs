/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function selectFormattingPaths(paths, kind) {
  if (kind !== 'markdown' && kind !== 'non-markdown') {
    throw new Error(`Unknown formatting path kind: ${kind}`)
  }
  return paths.filter((path) => {
    const markdown = /\.mdx?$/i.test(path)
    return kind === 'markdown' ? markdown : !markdown
  })
}

export function changedFormattingPaths(
  base,
  head,
  kind,
  { execute = execFileSync, exists = existsSync } = {}
) {
  // Classify the pull request's own files (merge-base...head). Two-dot base..head
  // also includes later main commits, including paths already deleted from the tree.
  const mergeBase = execute('git', ['merge-base', base, head], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/i.test(mergeBase)) {
    throw new Error('Unable to resolve a merge-base commit for formatting checks')
  }
  const diff = execute('git', ['diff', '--name-only', '--diff-filter=ACMR', '-z', mergeBase, head])
  return selectFormattingPaths(diff.toString('utf8').split('\0').filter(Boolean), kind).filter(
    (path) => exists(path)
  )
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

function requireCommit(value, name) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} must be a full 40-character Git commit SHA`)
  }
  return value
}

export function runChangedFormatCli(
  arguments_ = process.argv.slice(2),
  { execute = execFileSync, exists = existsSync } = {}
) {
  const base = requireCommit(argumentValue(arguments_, '--base'), '--base')
  const head = requireCommit(argumentValue(arguments_, '--head'), '--head')
  const kind = argumentValue(arguments_, '--kind')
  const paths = changedFormattingPaths(base, head, kind, { execute, exists })

  if (paths.length === 0) {
    process.stdout.write(`No changed ${kind} files require formatting checks.\n`)
    return
  }

  const result = spawnSync(
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--check', '--ignore-unknown', '--', ...paths],
    { stdio: 'inherit' }
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runChangedFormatCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
