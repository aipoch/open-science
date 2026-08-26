import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { publishNoReplace } from './atomic-no-replace-publisher'

const require = createRequire(import.meta.url)
const nativeBindingAvailable = (() => {
  try {
    require('../../../packages/safe-file-publisher-native')
    return true
  } catch {
    return false
  }
})()

let cleanupRoot: string | undefined

const waitForPath = async (path: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 5))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

afterEach(async () => {
  if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true })
  cleanupRoot = undefined
})

describe.skipIf(!nativeBindingAvailable)('atomic no-replace publisher', () => {
  it('reports publication capabilities for a local storage root', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const binding = require('../../../packages/safe-file-publisher-native') as {
      inspectPath: (path: string) => { isRemote: boolean; supportsHardLinks: boolean }
    }

    expect(binding.inspectPath(cleanupRoot)).toEqual({
      isRemote: false,
      supportsHardLinks: true
    })
  })

  it('publishes within an anchored parent without replacing an existing destination', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const sourcePath = join(cleanupRoot, 'source.tmp')
    const destinationPath = join(cleanupRoot, 'content')
    await writeFile(sourcePath, 'verified')

    publishNoReplace(cleanupRoot, cleanupRoot, basename(sourcePath), basename(destinationPath))

    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
    if (process.platform === 'win32') {
      await expect(readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('')
    }

    await writeFile(sourcePath, 'next')
    expect(() =>
      publishNoReplace(cleanupRoot!, cleanupRoot!, basename(sourcePath), basename(destinationPath))
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('next')
  })

  it.skipIf(process.platform === 'win32')(
    'publishes the already-open source when its pathname is replaced concurrently',
    async () => {
      cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
      const sourcePath = join(cleanupRoot, 'source.tmp')
      const retainedSourcePath = join(cleanupRoot, 'retained-source.tmp')
      const attackerPath = join(cleanupRoot, 'attacker.tmp')
      const destinationPath = join(cleanupRoot, 'content')
      const openedMarker = join(cleanupRoot, 'source-opened.marker')
      const resumeMarker = join(cleanupRoot, 'source-resume.marker')
      await writeFile(sourcePath, 'verified')
      await writeFile(attackerPath, 'attacker')

      const child = spawn(
        process.execPath,
        [
          '-e',
          `
          const binding = require(process.argv[1])
          binding.publishNoReplace(process.argv[2], '', 'source.tmp', 'content')
        `,
          join(process.cwd(), 'packages/safe-file-publisher-native'),
          cleanupRoot
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: 'test',
            VITEST: 'true',
            OPEN_SCIENCE_NATIVE_TEST_HOOKS: '1',
            OPEN_SCIENCE_TEST_OPENED_SOURCE_MARKER: openedMarker,
            OPEN_SCIENCE_TEST_OPENED_SOURCE_RESUME: resumeMarker
          },
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )
      let childStderr = ''
      child.stderr.on('data', (chunk) => {
        childStderr += String(chunk)
      })
      const childExit = new Promise<number | null>((resolveExit, rejectExit) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL')
          rejectExit(new Error('atomic publisher child exit timed out'))
        }, 5_000)
        child.once('exit', (code) => {
          clearTimeout(timeout)
          resolveExit(code)
        })
        child.once('error', rejectExit)
      })

      await Promise.race([
        waitForPath(openedMarker),
        childExit.then((code) => {
          throw new Error(`publisher exited ${code} before source-opened marker: ${childStderr}`)
        })
      ])
      await rename(sourcePath, retainedSourcePath)
      await rename(attackerPath, sourcePath)
      await writeFile(resumeMarker, 'resume')
      expect(await childExit).toBe(0)

      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('attacker')
      await expect(readFile(retainedSourcePath, 'utf8')).resolves.toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'publishes a read-only source without requiring permission to truncate it',
    async () => {
      cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
      const sourcePath = join(cleanupRoot, 'source.tmp')
      const destinationPath = join(cleanupRoot, 'content')
      await writeFile(sourcePath, 'verified')
      await chmod(sourcePath, 0o444)

      publishNoReplace(cleanupRoot, cleanupRoot, basename(sourcePath), basename(destinationPath))

      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('verified')
    }
  )

  it('rejects a symlinked or junction publication parent', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const outsideParent = join(cleanupRoot, 'outside')
    const linkedParent = join(cleanupRoot, 'linked')
    await mkdir(outsideParent)
    await writeFile(join(outsideParent, 'source.tmp'), 'verified')
    await symlink(outsideParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => publishNoReplace(cleanupRoot!, linkedParent, 'source.tmp', 'content')).toThrow()
    await expect(readFile(join(outsideParent, 'content'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
