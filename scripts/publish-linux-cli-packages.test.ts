import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { collectPackages, digest, linuxTargets } from './linux-cli-packages.mjs'
import { publicationFiles, publishPackages } from './publish-linux-cli-packages.mjs'

const gh = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: gh
}))
const sourceSha = 'a'.repeat(40)
const version = '0.37.1'
let directory: string
let files: string[]
let remote: Map<string, Buffer>
let failedDownload: string | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cli-publication-'))
  const reports = []
  for (const [target, [debArch, rpmArch]] of Object.entries(linuxTargets)) {
    for (const format of ['deb', 'rpm']) {
      const filename =
        format === 'deb'
          ? `open-science-cli_${version}_${debArch}.deb`
          : `open-science-cli-${version}-1.${rpmArch}.rpm`
      await writeFile(join(directory, filename), `${target}/${format}`)
      const report = {
        version,
        sourceSha,
        target,
        nodeVersion: '22.23.3',
        filename,
        format,
        sha256: await digest(join(directory, filename)),
        sourceArchive: `open-science-${version}-${target}.tar.gz`,
        sourceArchiveSha256: 'b'.repeat(64)
      }
      reports.push(report)
      await writeFile(join(directory, `package-${format}-${target}.json`), JSON.stringify(report))
    }
  }
  await collectPackages(directory, version, sourceSha)
  files = publicationFiles(reports)
  remote = new Map([['SHA256SUMS.txt', Buffer.from('original checksum manifest')]])
  failedDownload = undefined
  gh.mockReset()
  gh.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe('gh')
    if (args[0] === 'api') return sourceSha + '\n'
    if (args[1] === 'view')
      return JSON.stringify({
        isDraft: false,
        isPrerelease: false,
        assets: [...remote.keys()].map((name) => ({ name })),
        url: 'https://github.com/aipoch/open-science/releases/tag/v0.37.1'
      })
    if (args[1] === 'download') {
      const filename = args[args.indexOf('--pattern') + 1]
      if (filename === failedDownload) throw new Error('Remote inspection failed')
      const bytes = remote.get(filename)
      if (!bytes) throw new Error('Unknown remote asset')
      writeFileSync(join(args[args.indexOf('--dir') + 1], filename), bytes)
      return ''
    }
    if (args[1] === 'upload') return ''
    throw new Error(`Unexpected gh invocation: ${JSON.stringify(args)}`)
  })
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
const uploads = (): string[][] =>
  gh.mock.calls.map(([, args]) => args as string[]).filter((args) => args[1] === 'upload')
const publish = (write = true): Promise<{ pending: string[] }> =>
  publishPackages(directory, `v${version}`, 'aipoch/open-science', write)

describe('immutable supplemental Release publication', () => {
  it('defaults to a dry-run with no writes', async () => {
    const result = await publishPackages(directory, `v${version}`, 'aipoch/open-science')
    expect(result.pending).toEqual(files)
    expect(uploads()).toEqual([])
  })
  it('rejects a later conflicting asset before uploading earlier missing assets', async () => {
    remote.set(files.at(-1)!, Buffer.from('conflicting published provenance'))
    await expect(publish()).rejects.toThrow('Published bytes are immutable')
    expect(uploads()).toEqual([])
  })
  it('fails closed when an existing asset cannot be inspected', async () => {
    remote.set(files.at(-1)!, await readFile(join(directory, files.at(-1)!)))
    failedDownload = files.at(-1)
    await expect(publish()).rejects.toThrow('Remote inspection failed')
    expect(uploads()).toEqual([])
  })
  it('does not write on an identical complete retry', async () => {
    for (const filename of files) remote.set(filename, await readFile(join(directory, filename)))
    expect((await publish()).pending).toEqual([])
    expect(uploads()).toEqual([])
  })
  it('uploads only missing allowed assets on a partial retry without replacing original assets', async () => {
    remote.set(files[0], await readFile(join(directory, files[0])))
    const pending = files.slice(1)
    expect((await publish()).pending).toEqual(pending)
    expect(uploads()).toHaveLength(1)
    expect(
      uploads()[0]
        .slice(5)
        .map((path) => basename(path))
    ).toEqual(pending)
    expect(uploads()[0]).not.toContain('--clobber')
    expect(uploads()[0]).not.toContain('SHA256SUMS.txt')
    expect(remote.get('SHA256SUMS.txt')!.toString()).toBe('original checksum manifest')
  })
})
