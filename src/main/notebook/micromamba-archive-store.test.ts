import crypto, { createHash } from 'node:crypto'
import { renameSync, symlinkSync } from 'node:fs'
import filesystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  archiveAuthorizationsFromCondaResult,
  archiveAuthorizationsFromExplicitLock,
  publishMicromambaArchives,
  type MicromambaArchiveAuthorization
} from './micromamba-archive-store'

const roots: string[] = []

const authorization = (
  file: string,
  contents: string,
  algorithm: MicromambaArchiveAuthorization['algorithm'] = 'sha256'
): MicromambaArchiveAuthorization => ({
  file,
  algorithm,
  digest: createHash(algorithm).update(contents).digest('hex')
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('publishMicromambaArchives', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects an archive replaced by a symlink after enumeration',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'os-archive-enumeration-race-'))
      roots.push(root)
      const working = join(root, 'working')
      await mkdir(working)
      const source = join(working, 'a.conda')
      const outside = join(root, 'outside.conda')
      await writeFile(source, 'trusted')
      await writeFile(outside, 'trusted')
      const expected = authorization('a.conda', 'trusted')
      const original = filesystem.realpath
      let replaced = false
      vi.spyOn(filesystem, 'realpath').mockImplementation(async (path, ...args) => {
        const result = await original(path, ...args)
        if (path === source && !replaced) {
          replaced = true
          renameSync(source, `${source}.old`)
          symlinkSync(outside, source)
        }
        return result
      })
      syncBuiltinESMExports()
      await expect(
        publishMicromambaArchives(join(root, 'runtime'), working, [expected])
      ).rejects.toThrow()
      expect(replaced).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'publishes the verified snapshot if the source is replaced when its digest completes',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'os-archive-copy-race-'))
      roots.push(root)
      const working = join(root, 'working')
      await mkdir(working)
      const source = join(working, 'a.conda')
      const outside = join(root, 'outside.conda')
      await writeFile(source, 'trusted')
      await writeFile(outside, 'outside bytes must not be copied')
      const expected = authorization('a.conda', 'trusted')
      const original = crypto.createHash
      let replaced = false
      vi.spyOn(crypto, 'createHash').mockImplementation((...args) => {
        const hash = original(...args)
        const digest = hash.digest.bind(hash)
        vi.spyOn(hash, 'digest').mockImplementation((encoding) => {
          const result = digest(encoding)
          if (!replaced) {
            replaced = true
            renameSync(source, `${source}.old`)
            symlinkSync(outside, source)
          }
          return result
        })
        return hash
      })
      syncBuiltinESMExports()
      await expect(
        publishMicromambaArchives(join(root, 'runtime'), working, [expected])
      ).resolves.toBe(1)
      expect(replaced).toBe(true)
      expect(await readFile(join(root, 'runtime', 'pkgs', 'a.conda'), 'utf8')).toBe('trusted')
    }
  )

  it.skipIf(process.platform === 'win32').each(['archive', 'directory'])(
    'does not publish an authorized archive reached through a %s symlink',
    async (linkType) => {
      const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-untrusted-link-'))
      roots.push(root)
      const runtimeRoot = join(root, 'runtime')
      const workingRoot = join(root, 'working')
      const outside = join(root, 'outside')
      const file = 'python-3.12-0.conda'
      await mkdir(workingRoot)
      await mkdir(outside)
      await writeFile(join(outside, file), 'trusted archive')
      if (linkType === 'archive') await symlink(join(outside, file), join(workingRoot, file))
      else await symlink(outside, join(workingRoot, 'extracted-directory'))

      await expect(
        publishMicromambaArchives(runtimeRoot, workingRoot, [
          authorization(file, 'trusted archive')
        ])
      ).rejects.toThrow(/authorized package archive is unavailable/)
      await expect(readFile(join(runtimeRoot, 'pkgs', file))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'publishes verified archives alongside extracted Python and dylib symlinks',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-extracted-links-'))
      roots.push(root)
      const runtimeRoot = join(root, 'runtime')
      const workingRoot = join(root, 'working')
      const extracted = join(workingRoot, 'python-3.12-0')
      await mkdir(join(extracted, 'bin'), { recursive: true })
      await mkdir(join(extracted, 'lib'))
      await writeFile(join(extracted, 'bin', 'python3.12'), 'extracted executable')
      await symlink('python3.12', join(extracted, 'bin', 'python'))
      await symlink('libpython3.12.dylib', join(extracted, 'lib', 'libpython.dylib'))
      await writeFile(join(workingRoot, 'python-3.12-0.conda'), 'trusted archive')

      await expect(
        publishMicromambaArchives(runtimeRoot, workingRoot, [
          authorization('python-3.12-0.conda', 'trusted archive')
        ])
      ).resolves.toBe(1)
      expect(await readFile(join(runtimeRoot, 'pkgs', 'python-3.12-0.conda'), 'utf8')).toBe(
        'trusted archive'
      )
    }
  )

  it('derives archive authority from explicit locks and structured transaction results', () => {
    const md5 = createHash('md5').update('a').digest('hex')
    const sha256 = createHash('sha256').update('b').digest('hex')

    expect(
      archiveAuthorizationsFromExplicitLock(
        `@EXPLICIT\nhttps://conda.example/win-64/a-1.tar.bz2#${md5}\n`
      )
    ).toEqual([{ file: 'a-1.tar.bz2', algorithm: 'md5', digest: md5 }])
    expect(
      archiveAuthorizationsFromCondaResult({
        actions: { FETCH: [{ fn: 'b-1.conda', sha256 }] }
      })
    ).toEqual([{ file: 'b-1.conda', algorithm: 'sha256', digest: sha256 }])
  })

  it('publishes nested package archives into the durable data-root store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-'))
    roots.push(root)
    const runtimeRoot = join(root, 'OpenScience', 'runtime')
    const workingRoot = join(root, 'OpenScienceTmp', 'm-test')
    await mkdir(join(workingRoot, 'https', 'conda.example', 'win-64'), { recursive: true })
    await writeFile(join(workingRoot, 'https', 'conda.example', 'win-64', 'a-1.conda'), 'a')
    await writeFile(join(workingRoot, 'b-1.tar.bz2'), 'b')
    await writeFile(join(workingRoot, 'injected-1.conda'), 'malicious')
    await writeFile(join(workingRoot, 'tampered-1.conda'), 'malicious')
    await writeFile(join(workingRoot, 'repodata.json'), 'ignored')

    await expect(
      publishMicromambaArchives(runtimeRoot, workingRoot, [
        authorization('a-1.conda', 'a'),
        authorization('b-1.tar.bz2', 'b', 'md5')
      ])
    ).resolves.toBe(2)

    expect(await readFile(join(runtimeRoot, 'pkgs', 'a-1.conda'), 'utf8')).toBe('a')
    expect(await readFile(join(runtimeRoot, 'pkgs', 'b-1.tar.bz2'), 'utf8')).toBe('b')
    await expect(readFile(join(runtimeRoot, 'pkgs', 'injected-1.conda'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(join(runtimeRoot, 'pkgs', 'tampered-1.conda'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('retains publication evidence when an authorized archive is missing or tampered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-incomplete-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'working')
    await mkdir(workingRoot)
    await writeFile(join(workingRoot, 'tampered-1.conda'), 'malicious')

    await expect(
      publishMicromambaArchives(runtimeRoot, workingRoot, [
        authorization('tampered-1.conda', 'trusted')
      ])
    ).rejects.toThrow(/unavailable|verification/i)
    await expect(readFile(join(runtimeRoot, 'pkgs', 'tampered-1.conda'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('accepts an absent recovered source after every authorized archive is durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-durable-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'removed-working-cache')
    const expected = authorization('a-1.conda', 'trusted')
    await mkdir(join(runtimeRoot, 'pkgs'), { recursive: true })
    await writeFile(join(runtimeRoot, 'pkgs', expected.file), 'trusted')

    await expect(publishMicromambaArchives(runtimeRoot, workingRoot, [expected])).resolves.toBe(0)
  })

  it('revalidates the source only when durable archives are still missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-revalidate-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'working')
    const validateWorkingRoot = vi.fn().mockReturnValue(false)

    await expect(
      publishMicromambaArchives(
        runtimeRoot,
        workingRoot,
        [authorization('a-1.conda', 'trusted')],
        undefined,
        validateWorkingRoot
      )
    ).rejects.toThrow(/trust validation/i)
    expect(validateWorkingRoot).toHaveBeenCalledOnce()
  })

  it('aborts when the validated root identity changes during traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-traversal-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'working')
    await mkdir(workingRoot)
    await writeFile(join(workingRoot, 'a-1.conda'), 'trusted')
    const validateWorkingRoot = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    await expect(
      publishMicromambaArchives(
        runtimeRoot,
        workingRoot,
        [authorization('a-1.conda', 'trusted')],
        undefined,
        validateWorkingRoot
      )
    ).rejects.toThrow(/changed during archive traversal/i)
    expect(validateWorkingRoot).toHaveBeenCalledTimes(3)
  })

  it('refuses to overwrite a conflicting durable archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-conflict-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'working')
    await mkdir(join(runtimeRoot, 'pkgs'), { recursive: true })
    await mkdir(workingRoot)
    await writeFile(join(runtimeRoot, 'pkgs', 'a-1.conda'), 'trusted')
    await writeFile(join(workingRoot, 'a-1.conda'), 'different')

    await expect(
      publishMicromambaArchives(runtimeRoot, workingRoot, [
        authorization('a-1.conda', 'different', 'md5')
      ])
    ).rejects.toThrow(/conflicts/i)
    expect(await readFile(join(runtimeRoot, 'pkgs', 'a-1.conda'), 'utf8')).toBe('trusted')
  })

  it('does not trust mutable environment metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-untrusted-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'working')
    const prefix = join(runtimeRoot, 'envs', 'default-python')
    await mkdir(workingRoot, { recursive: true })
    await mkdir(join(prefix, 'conda-meta'), { recursive: true })
    await writeFile(join(workingRoot, 'injected-1.conda'), 'malicious')
    await writeFile(
      join(prefix, 'conda-meta', 'injected-1.json'),
      JSON.stringify({
        fn: 'injected-1.conda',
        sha256: createHash('sha256').update('malicious').digest('hex')
      })
    )

    await expect(publishMicromambaArchives(runtimeRoot, workingRoot, [])).resolves.toBe(0)
    await expect(readFile(join(runtimeRoot, 'pkgs', 'injected-1.conda'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects conflicting transaction authorizations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-auth-conflict-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'working')
    await mkdir(workingRoot)
    await writeFile(join(workingRoot, 'a-1.conda'), 'a')

    await expect(
      publishMicromambaArchives(runtimeRoot, workingRoot, [
        authorization('a-1.conda', 'a'),
        authorization('a-1.conda', 'different')
      ])
    ).rejects.toThrow(/authorizations conflict/i)
  })

  it('accepts equivalent MD5 and SHA-256 authority for the same archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-mm-archive-multi-digest-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const workingRoot = join(root, 'working')
    await mkdir(workingRoot)
    await writeFile(join(workingRoot, 'a-1.conda'), 'a')

    await expect(
      publishMicromambaArchives(runtimeRoot, workingRoot, [
        authorization('a-1.conda', 'a', 'md5'),
        authorization('a-1.conda', 'a', 'sha256')
      ])
    ).resolves.toBe(1)
    expect(await readFile(join(runtimeRoot, 'pkgs', 'a-1.conda'), 'utf8')).toBe('a')
  })
})
