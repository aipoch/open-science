import { describe, expect, it } from 'vitest'

import { managedFileVersionNativeCapability } from './atomic-no-replace-publisher'

describe('managed file version native capability', () => {
  it('reports NATIVE_WRITE_REQUIRED when the native binding cannot load', () => {
    expect(
      managedFileVersionNativeCapability(() => {
        throw Object.assign(new Error('native module missing'), { code: 'MODULE_NOT_FOUND' })
      })
    ).toEqual({
      available: false,
      reason: 'NATIVE_WRITE_REQUIRED',
      readFallbackAvailable: false
    })
  })

  it('reports NATIVE_WRITE_REQUIRED when the native binding cannot publish anchored writes', () => {
    const completeBinding = {
      supportsAnchoredWrites: false,
      publishNoReplace: () => undefined,
      writeAndPublishNoReplace: () => undefined,
      readFile: () => Buffer.alloc(0),
      readFileBounded: () => Buffer.alloc(0),
      publishVerifiedNoReplace: () => undefined,
      verifyFile: () => true,
      statFile: () => ({ sizeBytes: 0 }),
      removeFile: () => false,
      listDirectory: () => []
    }

    expect(managedFileVersionNativeCapability(() => completeBinding)).toEqual({
      available: false,
      reason: 'NATIVE_WRITE_REQUIRED',
      readFallbackAvailable: true
    })
  })

  it('rejects a corrupt binding shape instead of reporting partial support', () => {
    expect(managedFileVersionNativeCapability(() => ({ readFile: () => Buffer.alloc(0) }))).toEqual(
      {
        available: false,
        reason: 'NATIVE_WRITE_REQUIRED',
        readFallbackAvailable: false
      }
    )
  })

  it('reports the compiled binding capability for the current platform', () => {
    expect(managedFileVersionNativeCapability()).toEqual(
      process.platform === 'win32'
        ? {
            available: false,
            reason: 'NATIVE_WRITE_REQUIRED',
            readFallbackAvailable: true
          }
        : { available: true, readFallbackAvailable: false }
    )
  })
})
