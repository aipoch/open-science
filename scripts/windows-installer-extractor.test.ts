import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Arch } = require('builder-util')
const script = readFileSync('build/stage-windows-extractor.cjs', 'utf8')
const toolDirectory = process.env.OPEN_SCIENCE_7ZIP_EXTRA

function fixture(): string {
  const parent = resolve('tmp/installer-extractor-tests')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, 'case-'))
}

function loadStage(cache: string): {
  stage: (context: unknown) => Promise<void>
  download: ReturnType<typeof vi.fn>
  compile: ReturnType<typeof vi.fn>
} {
  const download = vi.fn(async () => cache)
  const compile = vi.fn((source: string, destination: string) => {
    expect(
      existsSync(source),
      'helper source must exist outside the isolated fixture project'
    ).toBe(true)
    writeFileSync(destination, 'compiled helper')
  })
  const module = { exports: undefined as unknown as (context: unknown) => Promise<void> }
  runInNewContext(script, {
    module,
    __dirname: resolve('build'),
    require: (id: string) =>
      id === 'app-builder-lib/out/binDownload'
        ? { getBinFromCustomLoc: download }
        : id === './compile-windows-install-publication.cjs'
          ? compile
          : require(id)
  })
  return { stage: module.exports, download, compile }
}

describe('verified Windows installer extractor', () => {
  it('rejects unknown architectures before downloading or signing', async () => {
    const { stage, download } = loadStage(fixture())
    const signIf = vi.fn()
    await expect(
      stage({ electronPlatformName: 'win32', arch: -1, packager: { signIf } })
    ).rejects.toThrow('Unsupported Windows extractor target')
    expect(download).not.toHaveBeenCalled()
    expect(signIf).not.toHaveBeenCalled()
  })

  it('rejects tampered cached executables before staging or signing', async () => {
    const root = fixture()
    mkdirSync(join(root, 'x64'))
    writeFileSync(join(root, 'x64/7za.exe'), 'tampered cached executable')
    const { stage, download } = loadStage(root)
    const signIf = vi.fn()
    await expect(
      stage({
        electronPlatformName: 'win32',
        arch: Arch.x64,
        appOutDir: join(root, 'app'),
        packager: { projectDir: root, signIf }
      })
    ).rejects.toThrow('Extractor checksum mismatch')
    expect(download).toHaveBeenCalledWith(
      'open-science-7zip',
      '26.04',
      'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-extra.7z',
      'dc4b11d3399db18b063630137145f5585d8f7ac847bf3639bd1185d7d1f7cee0'
    )
    expect(signIf).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it.skipIf(!toolDirectory)(
    'copies and signs the verified target tool without modifying the cache',
    async () => {
      const root = fixture()
      const original = readFileSync(join(toolDirectory!, 'x64/7za.exe'))
      const { stage, compile } = loadStage(toolDirectory!)
      const destination = join(root, 'out/windows-installer/x64/7za.exe')
      const signIf = vi.fn(async (file: string) => {
        if (file.endsWith('.dll')) {
          expect(readFileSync(file, 'utf8')).toBe('compiled helper')
          return
        }
        expect(file).toBe(destination)
        expect(readFileSync(file).equals(original)).toBe(true)
        writeFileSync(file, Buffer.concat([original, Buffer.from('test-signature')]))
      })
      const context = {
        electronPlatformName: 'win32',
        arch: Arch.x64,
        appOutDir: join(root, 'app'),
        packager: { projectDir: root, signIf }
      }
      await stage(context)
      await stage(context)
      expect(signIf).toHaveBeenCalledTimes(4)
      expect(compile).toHaveBeenCalledWith(
        resolve('build/windows-install-publication.cs'),
        join(root, 'out/windows-installer/x64/windows-install-publication.dll')
      )
      expect(readFileSync(join(toolDirectory!, 'x64/7za.exe')).equals(original)).toBe(true)
      expect(readFileSync(join(root, 'app/resources/7zip-LICENSE.txt'))).toEqual(
        readFileSync(join(toolDirectory!, 'License.txt'))
      )
      expect(createHash('sha256').update(original).digest('hex')).toBe(
        '15d4c788c148e3677e2fc1c4a01f191fb6669eba4f6acf8a465f0f1a6f1e1260'
      )
      expect(existsSync(join(root, 'app/resources/7za.exe'))).toBe(false)
    }
  )
})
