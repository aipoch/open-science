import { pathToFileURL } from 'node:url'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type ChildResult = {
  phase?: string
  replayedVersionId?: string
  recovered: { recoveredMessageArtifacts: unknown[] }
  versions: Array<{ id: string; state: string; messageId: string }>
}

let testRoot: string
let entry: string
beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'artifact-save-crash-'))
  entry = join(testRoot, 'child.cjs')
  await build({
    entryPoints: [resolve('src/main/artifacts/test-support/save-crash-child.ts')],
    outfile: entry,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    logLevel: 'silent'
  })
})
afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})
const start = (
  root: string,
  phase: string
): { child: ChildProcess; message: Promise<ChildResult>; exited: Promise<void> } => {
  const child = fork(entry, [root, phase], {
    silent: true,
    env: { ...process.env, NODE_PATH: resolve('node_modules') }
  })
  let stderr = ''
  child.stderr!.on('data', (data) => {
    stderr += data
  })
  const message = new Promise<ChildResult>((resolve, reject) => {
    child.once('message', (value) => resolve(value as ChildResult))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`child failed (${code}): ${stderr}`))
    })
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
  return { child, message, exited }
}

describe('Artifact save durability across process termination', () => {
  it.each(['copying', 'before-version', 'staging', 'committed', 'prepared', 'partial-publication'])(
    'recovers %s with a newly started process and database connection',
    async (phase) => {
      const root = join(testRoot, phase)
      const writer = start(root, phase)
      try {
        expect(await writer.message).toEqual({ phase })
      } finally {
        writer.child.kill('SIGKILL')
        await writer.exited
      }
      const recovery = start(root, 'recover')
      try {
        const result = await recovery.message
        await recovery.exited
        if (phase === 'copying') {
          expect(result.versions).toEqual([])
          expect(result.recovered.recoveredMessageArtifacts).toEqual([])
          const pending = await readdir(
            join(root, 'artifacts/project-1/artifact-session-1/.pending/artifact-run-1')
          )
          expect(pending.some((name) => name.endsWith('.tmp'))).toBe(true)
        } else if (phase === 'before-version') {
          expect(result.versions).toEqual([])
          expect(result.recovered.recoveredMessageArtifacts).toEqual([])
          expect(
            await readFile(
              join(
                root,
                'artifacts/project-1/artifact-session-1/.pending/artifact-run-1/first.txt'
              ),
              'utf8'
            )
          ).toBe('first crash-safe bytes')
        } else if (phase === 'staging' || phase === 'committed') {
          expect(result.replayedVersionId).toBe(result.versions[0].id)
          expect(result.versions).toEqual([
            expect.objectContaining({ state: 'pending', messageId: null })
          ])
        } else {
          expect(result.versions).toHaveLength(2)
          expect(
            result.versions.every(
              (version: { state: string; messageId: string }) =>
                version.state === 'finalized' && version.messageId === 'message-1'
            )
          ).toBe(true)
          expect(
            await readFile(join(root, 'artifacts/project-1/session-1/message-1/first.txt'), 'utf8')
          ).toBe('first crash-safe bytes')
          expect(
            await readFile(join(root, 'artifacts/project-1/session-1/message-1/second.txt'), 'utf8')
          ).toBe('second crash-safe bytes')
        }
      } finally {
        if (recovery.child.exitCode === null) {
          recovery.child.kill('SIGKILL')
          await recovery.exited
        }
      }
    },
    30_000
  )
})
