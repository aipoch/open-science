import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { publishNoReplace } from './atomic-no-replace-publisher'

const require = createRequire(import.meta.url)
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

describe('atomic no-replace publisher', () => {
  it('publishes from the already-open verified descriptor on every POSIX platform', async () => {
    const source = await readFile(
      new URL(
        '../../../packages/safe-file-publisher-native/src/safe_file_publisher_native.cc',
        import.meta.url
      ),
      'utf8'
    )

    expect(source).toMatch(
      /linkat\(\s*file_fd,\s*"",\s*parent_fd,\s*destination_name\.c_str\(\),\s*AT_EMPTY_PATH\s*\)/
    )
    expect(
      source.match(/fclonefileat\(file_fd, parent_fd, destination_name\.c_str\(\), 0\)/g)
    ).toHaveLength(2)
  })

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
    await expect(readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(sourcePath, 'next')
    expect(() =>
      publishNoReplace(cleanupRoot!, cleanupRoot!, basename(sourcePath), basename(destinationPath))
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('next')
  })

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

  it('creates, reads, and removes a temporary file through anchored no-follow handles', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const binding = require('../../../packages/safe-file-publisher-native') as {
      writeAndPublishNoReplace: (
        rootPath: string,
        relativeParentPath: string,
        temporaryName: string,
        destinationName: string,
        bytes: Buffer
      ) => void
      readFile: (rootPath: string, relativeParentPath: string, name: string) => Buffer
      statFile: (
        rootPath: string,
        relativeParentPath: string,
        name: string
      ) => {
        sizeBytes: number
      }
      removeFile: (rootPath: string, relativeParentPath: string, name: string) => boolean
    }
    const parentPath = join(cleanupRoot, 'new', 'nested')
    const relativeParentPath = relative(cleanupRoot, parentPath)

    binding.writeAndPublishNoReplace(
      cleanupRoot,
      relativeParentPath,
      'content.tmp',
      'content',
      Buffer.from('safe')
    )

    expect(binding.readFile(cleanupRoot, relativeParentPath, 'content')).toEqual(
      Buffer.from('safe')
    )
    expect(binding.statFile(cleanupRoot, relativeParentPath, 'content')).toEqual({ sizeBytes: 4 })
    expect(binding.removeFile(cleanupRoot, relativeParentPath, 'content')).toBe(true)
    expect(binding.removeFile(cleanupRoot, relativeParentPath, 'content')).toBe(false)
  })

  it('enforces bounded reads atomically and streams integrity verification', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const binding = require('../../../packages/safe-file-publisher-native') as {
      readFileBounded: (
        rootPath: string,
        relativeParentPath: string,
        name: string,
        maxBytes: number
      ) => Buffer
      verifyFile: (
        rootPath: string,
        relativeParentPath: string,
        name: string,
        expectedSizeBytes: number,
        expectedSha256: string
      ) => boolean
    }
    const bytes = Buffer.alloc(3 * 64 * 1024 + 17, 0x5a)
    await writeFile(join(cleanupRoot, 'large.bin'), bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    expect(binding.readFileBounded(cleanupRoot, '', 'large.bin', bytes.length)).toEqual(bytes)
    expect(() => binding.readFileBounded(cleanupRoot!, '', 'large.bin', bytes.length - 1)).toThrow(
      expect.objectContaining({ code: 'EFBIG' })
    )
    expect(binding.verifyFile(cleanupRoot, '', 'large.bin', bytes.length, sha256)).toBe(true)
    expect(binding.verifyFile(cleanupRoot, '', 'large.bin', bytes.length, '0'.repeat(64))).toBe(
      false
    )
    expect(binding.verifyFile(cleanupRoot, '', 'large.bin', bytes.length + 1, sha256)).toBe(false)

    await symlink(join(cleanupRoot, 'large.bin'), join(cleanupRoot, 'linked.bin'))
    expect(() => binding.readFileBounded(cleanupRoot!, '', 'linked.bin', bytes.length)).toThrow(
      expect.objectContaining({ code: 'ELOOP' })
    )
  })

  it('does not follow a bounded-read parent replaced outside the storage root', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-outside-'))
    const binding = require('../../../packages/safe-file-publisher-native') as {
      readFileBounded: (
        rootPath: string,
        relativeParentPath: string,
        name: string,
        maxBytes: number
      ) => Buffer
    }
    await mkdir(join(cleanupRoot, 'managed'))
    await writeFile(join(cleanupRoot, 'managed', 'entry.txt'), 'inside')
    await writeFile(join(outsideRoot, 'entry.txt'), 'outside')
    expect(binding.readFileBounded(cleanupRoot, 'managed', 'entry.txt', 6)).toEqual(
      Buffer.from('inside')
    )

    await rename(join(cleanupRoot, 'managed'), join(cleanupRoot, 'managed-real'))
    await symlink(outsideRoot, join(cleanupRoot, 'managed'))
    expect(() => binding.readFileBounded(cleanupRoot!, 'managed', 'entry.txt', 7)).toThrow(
      expect.objectContaining({ code: 'ELOOP' })
    )
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('rejects a file that grows after the bounded read descriptor is sized', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const filePath = join(cleanupRoot, 'growing.txt')
    const sizedMarker = join(cleanupRoot, 'bounded-sized.marker')
    const resumeMarker = join(cleanupRoot, 'bounded-resume.marker')
    await writeFile(filePath, 'bounded')
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
          const binding = require(process.argv[1])
          try {
            binding.readFileBounded(process.argv[2], '', 'growing.txt', 7)
            process.exit(2)
          } catch (error) {
            process.exit(error.code === 'EFBIG' ? 0 : 3)
          }
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
          OPEN_SCIENCE_TEST_BOUNDED_READ_MARKER: sizedMarker,
          OPEN_SCIENCE_TEST_BOUNDED_READ_RESUME: resumeMarker
        },
        stdio: 'ignore'
      }
    )
    const childExit = new Promise<number | null>((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        rejectExit(new Error('bounded read child exit timed out'))
      }, 5_000)
      child.once('exit', (code) => {
        clearTimeout(timeout)
        resolveExit(code)
      })
      child.once('error', rejectExit)
    })

    await Promise.race([
      waitForPath(sizedMarker),
      childExit.then((code) => {
        throw new Error(`bounded read child exited ${code} before size marker`)
      })
    ])
    await writeFile(filePath, 'bounded!')
    await writeFile(resumeMarker, 'resume')
    expect(await childExit).toBe(0)
  })

  it('publishes only the verified recovery temp and never replaces a destination', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const binding = require('../../../packages/safe-file-publisher-native') as {
      publishVerifiedNoReplace: (
        rootPath: string,
        relativeParentPath: string,
        temporaryName: string,
        destinationName: string,
        expectedBytes: Buffer
      ) => void
    }
    const expected = Buffer.from('verified recovery')
    await writeFile(join(cleanupRoot, 'valid.tmp'), expected)

    binding.publishVerifiedNoReplace(cleanupRoot, '', 'valid.tmp', 'recovered.txt', expected)
    await expect(readFile(join(cleanupRoot, 'recovered.txt'))).resolves.toEqual(expected)
    await expect(readFile(join(cleanupRoot, 'valid.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(join(cleanupRoot, 'invalid.tmp'), 'tampered')
    expect(() =>
      binding.publishVerifiedNoReplace(cleanupRoot!, '', 'invalid.tmp', 'invalid.txt', expected)
    ).toThrow()
    await expect(readFile(join(cleanupRoot, 'invalid.tmp'), 'utf8')).resolves.toBe('tampered')
    await expect(readFile(join(cleanupRoot, 'invalid.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })

    await writeFile(join(cleanupRoot, 'next.tmp'), expected)
    await writeFile(join(cleanupRoot, 'occupied.txt'), 'original')
    expect(() =>
      binding.publishVerifiedNoReplace(cleanupRoot!, '', 'next.tmp', 'occupied.txt', expected)
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    await expect(readFile(join(cleanupRoot, 'occupied.txt'), 'utf8')).resolves.toBe('original')
    await expect(readFile(join(cleanupRoot, 'next.tmp'))).resolves.toEqual(expected)
  })

  it('never publishes or removes a replacement raced against an already-open recovery temp', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const expected = Buffer.alloc(4 * 1024, 0x5a)
    const attacker = Buffer.from('attacker replacement')
    const tempPath = join(cleanupRoot, 'raced.tmp')
    const attackerPath = join(cleanupRoot, 'attacker.tmp')
    const destinationPath = join(cleanupRoot, 'raced.txt')
    const verifiedMarker = join(cleanupRoot, 'verified.marker')
    const resumeMarker = join(cleanupRoot, 'resume.marker')
    await writeFile(tempPath, expected)
    await writeFile(attackerPath, attacker)
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
          const binding = require(process.argv[1])
          binding.publishVerifiedNoReplace(
            process.argv[2],
            '',
            'raced.tmp',
            'raced.txt',
            Buffer.alloc(4 * 1024, 0x5a)
          )
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
          OPEN_SCIENCE_TEST_VERIFIED_TEMP_MARKER: verifiedMarker,
          OPEN_SCIENCE_TEST_VERIFIED_TEMP_RESUME: resumeMarker
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
        rejectExit(new Error('replacement child exit timed out'))
      }, 5_000)
      child.once('exit', (code) => {
        clearTimeout(timeout)
        resolveExit(code)
      })
      child.once('error', rejectExit)
    })

    await Promise.race([
      waitForPath(verifiedMarker),
      childExit.then((code) => {
        throw new Error(`publisher exited ${code} before verification marker: ${childStderr}`)
      })
    ])
    await rename(attackerPath, tempPath)
    await writeFile(resumeMarker, 'resume')
    expect(await childExit).toBe(0)

    await expect(readFile(tempPath)).resolves.toEqual(attacker)
    const destination = await readFile(destinationPath)
    expect(destination.byteLength).toBe(expected.byteLength)
    expect(createHash('sha256').update(destination).digest('hex')).toBe(
      createHash('sha256').update(expected).digest('hex')
    )
  })

  it('publishes ordinary writes from their open descriptor without deleting a raced replacement', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const expected = Buffer.from('ordinary publication')
    const attacker = Buffer.from('ordinary attacker replacement')
    const tempPath = join(cleanupRoot, 'ordinary.tmp')
    const attackerPath = join(cleanupRoot, 'ordinary-attacker.tmp')
    const destinationPath = join(cleanupRoot, 'ordinary.txt')
    const verifiedMarker = join(cleanupRoot, 'ordinary-verified.marker')
    const resumeMarker = join(cleanupRoot, 'ordinary-resume.marker')
    await writeFile(attackerPath, attacker)
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
          const binding = require(process.argv[1])
          binding.writeAndPublishNoReplace(
            process.argv[2],
            '',
            'ordinary.tmp',
            'ordinary.txt',
            Buffer.from('ordinary publication')
          )
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
          OPEN_SCIENCE_TEST_VERIFIED_TEMP_MARKER: verifiedMarker,
          OPEN_SCIENCE_TEST_VERIFIED_TEMP_RESUME: resumeMarker
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
        rejectExit(new Error('ordinary publisher child exit timed out'))
      }, 5_000)
      child.once('exit', (code) => {
        clearTimeout(timeout)
        resolveExit(code)
      })
      child.once('error', rejectExit)
    })

    await Promise.race([
      waitForPath(verifiedMarker),
      childExit.then((code) => {
        throw new Error(`ordinary publisher exited ${code} before marker: ${childStderr}`)
      })
    ])
    await rename(attackerPath, tempPath)
    await writeFile(resumeMarker, 'resume')
    expect(await childExit).toBe(0)

    await expect(readFile(tempPath)).resolves.toEqual(attacker)
    await expect(readFile(destinationPath)).resolves.toEqual(expected)
  })

  it('rejects a stat after an ancestor is replaced with a symlink', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-outside-'))
    const binding = require('../../../packages/safe-file-publisher-native') as {
      writeAndPublishNoReplace: (
        rootPath: string,
        relativeParentPath: string,
        temporaryName: string,
        destinationName: string,
        bytes: Buffer
      ) => void
      statFile: (
        rootPath: string,
        relativeParentPath: string,
        name: string
      ) => {
        sizeBytes: number
      }
    }
    binding.writeAndPublishNoReplace(
      cleanupRoot,
      'managed/stat',
      '.entry.tmp',
      'entry.txt',
      Buffer.from('entry')
    )
    expect(binding.statFile(cleanupRoot, 'managed/stat', 'entry.txt')).toEqual({ sizeBytes: 5 })

    await rename(join(cleanupRoot, 'managed'), join(cleanupRoot, 'managed-real'))
    await symlink(outsideRoot, join(cleanupRoot, 'managed'))
    expect(() => binding.statFile(cleanupRoot!, 'managed/stat', 'entry.txt')).toThrow(
      expect.objectContaining({ code: 'ELOOP' })
    )
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('never creates temporary bytes through a symlinked ancestor', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-outside-'))
    const linkedParent = join(cleanupRoot, 'linked')
    await symlink(outsideRoot, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')
    const binding = require('../../../packages/safe-file-publisher-native') as {
      writeAndPublishNoReplace: (
        rootPath: string,
        relativeParentPath: string,
        temporaryName: string,
        destinationName: string,
        bytes: Buffer
      ) => void
    }

    expect(() =>
      binding.writeAndPublishNoReplace(
        cleanupRoot!,
        'linked/nested',
        'content.tmp',
        'content',
        Buffer.from('escape')
      )
    ).toThrow(expect.objectContaining({ code: expect.stringMatching(/ELOOP|EIO|ENOENT/) }))
    await expect(readFile(join(outsideRoot, 'nested', 'content.tmp'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('lists metadata through an anchored directory without following a replaced parent', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-outside-'))
    const binding = require('../../../packages/safe-file-publisher-native') as {
      writeAndPublishNoReplace: (
        rootPath: string,
        relativeParentPath: string,
        temporaryName: string,
        destinationName: string,
        bytes: Buffer
      ) => void
      listDirectory: (
        rootPath: string,
        relativeParentPath: string
      ) => Array<{ name: string; isFile: boolean; mtimeMs: number }>
    }
    binding.writeAndPublishNoReplace(
      cleanupRoot,
      'managed/list',
      '.entry.tmp',
      'entry.txt',
      Buffer.from('entry')
    )

    expect(binding.listDirectory(cleanupRoot, 'managed/list')).toEqual([
      expect.objectContaining({ name: 'entry.txt', isFile: true })
    ])
    await rename(join(cleanupRoot, 'managed'), join(cleanupRoot, 'managed-real'))
    await symlink(outsideRoot, join(cleanupRoot, 'managed'))
    expect(() => binding.listDirectory(cleanupRoot!, 'managed/list')).toThrow(
      expect.objectContaining({ code: 'ELOOP' })
    )
    await rm(outsideRoot, { recursive: true, force: true })
  })
})
