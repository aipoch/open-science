import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { load } from 'js-yaml'

const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = fs
const { dirname, join, posix } = nodePath
const require = createRequire(import.meta.url)

it('edits the Windows launcher before signing and signs each bundled PE only once', async () => {
  const { NtExecutable } = require('resedit')
  const { editWindowsResources } = require('app-builder-lib/out/util/resEdit')
  const config = load(readFileSync('electron-builder.yml', 'utf8')) as {
    afterPack: string
    afterSign?: string
  }
  const directory = mkdtempSync(join(tmpdir(), 'open-science-signing-order-'))
  const calls: string[] = []
  const addPe = (relative: string): string => {
    const file = join(directory, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(NtExecutable.createEmpty().generate()))
    return file
  }
  // Stand in for Authenticode's certificate table, so the real resource editor rejects an
  // early signature exactly as it does in release packaging. No cloud credentials are needed.
  const markSigned = (file: string): void => {
    const data = readFileSync(file)
    const optional = data.readUInt32LE(0x3c) + 24
    const certificate = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96) + 4 * 8
    data.writeUInt32LE(data.length, certificate)
    data.writeUInt32LE(8, certificate + 4)
    writeFileSync(file, Buffer.concat([data, Buffer.alloc(8)]))
  }
  const main = addPe('open-science.exe')
  const helper = addPe('resources/app.asar.unpacked/node_modules/helper/helper.exe')
  const dll = addPe('dxcompiler.dll')
  const addon = addPe('resources/app.asar.unpacked/node_modules/addon/addon.node')
  const extra = addPe('resources/micromamba.exe')
  const vendor = addPe('vendor.dll')
  markSigned(vendor)
  const vendorBytes = readFileSync(vendor)
  const signIf = async (file: string): Promise<boolean> => {
    calls.push(file)
    markSigned(file)
    return true
  }
  const context = {
    electronPlatformName: 'win32',
    appOutDir: directory,
    packager: {
      appInfo: { productFilename: 'open-science' },
      platformSpecificBuildOptions: { azureSignOptions: {} },
      signIf
    }
  }
  try {
    await require(join(process.cwd(), config.afterPack)).default(context)
    // electron-builder edits the main EXE, signs it and unpacked helpers, then calls afterSign.
    await editWindowsResources({
      file: main,
      versionStrings: { ProductName: 'Open Science' },
      fileVersion: '1.2.3',
      productVersion: '1.2.3'
    })
    await signIf(main)
    await signIf(helper)
    if (config.afterSign) await require(join(process.cwd(), config.afterSign)).default(context)
    expect(calls.sort()).toEqual([main, helper, dll, addon, extra].sort())
    expect(readFileSync(vendor)).toEqual(vendorBytes)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

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
  runInNewContext(readFileSync('build/sign-windows.cjs', 'utf8'), {
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
