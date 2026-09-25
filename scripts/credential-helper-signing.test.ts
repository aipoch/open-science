import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = fs
const { dirname, join, posix } = nodePath

it('signs the unpacked credential executables before signing the outer macOS application', async () => {
  const app = '/fixture/Open-Science.app'
  const calls: string[][] = []
  const exports: { default?: (context: unknown) => Promise<void> } = {}
  runInNewContext(readFileSync('build/adhoc-sign.cjs', 'utf8'), {
    exports,
    __dirname: '/fixture/build',
    console: { log: vi.fn() },
    require: (id: string) => {
      if (id === 'node:path') return posix
      if (id === 'node:fs') return { existsSync: () => true }
      if (id === 'node:buffer') return { Buffer }
      if (id === 'node:child_process')
        return { execFileSync: (_command: string, args: string[]) => calls.push(args) }
      throw new Error(`Unexpected module ${id}`)
    }
  })
  await exports.default!({
    electronPlatformName: 'darwin',
    appOutDir: '/fixture',
    packager: { appInfo: { productFilename: 'Open-Science' } }
  })
  const packageDirectory = posix.join(
    app,
    'Contents/Resources/app.asar.unpacked/node_modules/@aipoch/credential-identity-probe-native/build/Release'
  )
  for (const executable of ['credential_identity_probe', 'credential_key_validator']) {
    const position = calls.findIndex(
      (args) => args.at(-1) === posix.join(packageDirectory, executable)
    )
    expect(position, executable).toBeGreaterThanOrEqual(0)
    expect(position).toBeLessThan(calls.findIndex((args) => args.at(-1) === app))
  }
})

it('signs every unsigned bundled Windows PE while preserving vendor signatures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-science-pe-signing-'))
  function addPe(relative: string, signed: boolean): string {
    const file = join(directory, relative)
    mkdirSync(dirname(file), { recursive: true })
    const data = Buffer.alloc(512)
    data.write('MZ', 0)
    data.writeUInt32LE(0x80, 0x3c)
    data.write('PE\0\0', 0x80)
    data.writeUInt16LE(0x20b, 0x80 + 24)
    if (signed) {
      const certificate = 0x80 + 24 + 112 + 4 * 8
      data.writeUInt32LE(0x200, certificate)
      data.writeUInt32LE(16, certificate + 4)
    }
    writeFileSync(file, data)
    return file
  }
  const unsignedDll = addPe('dxcompiler.dll', false)
  const unsignedNode = addPe('resources/node_modules/native-addon.node', false)
  const unsignedExe = addPe('resources/micromamba.exe', false)
  addPe('d3dcompiler_47.dll', true)
  addPe('open-science.exe', true)
  writeFileSync(join(directory, 'not-a-pe.dll'), 'not a PE')
  const calls: string[] = []
  const exports: { default?: (context: unknown) => Promise<void> } = {}
  runInNewContext(readFileSync('build/adhoc-sign.cjs', 'utf8'), {
    exports,
    console: { log: vi.fn() },
    require: (id: string) => {
      if (id === 'node:path') return nodePath
      if (id === 'node:fs') return fs
      if (id === 'node:buffer') return { Buffer }
      if (id === 'node:child_process') return { execFileSync: vi.fn() }
      throw new Error(`Unexpected module ${id}`)
    }
  })
  const options: { azureSignOptions?: object } = { azureSignOptions: {} }
  const packager = {
    platformSpecificBuildOptions: options,
    signIf: vi.fn(async (file: string) => calls.push(file))
  }
  try {
    await exports.default!({ electronPlatformName: 'win32', appOutDir: directory, packager })
    expect(calls.sort()).toEqual([unsignedDll, unsignedNode, unsignedExe].sort())

    delete options.azureSignOptions
    await exports.default!({ electronPlatformName: 'win32', appOutDir: directory, packager })
    expect(calls).toHaveLength(3)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
