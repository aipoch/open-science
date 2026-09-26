import { describe, expect, it } from 'vitest'

import {
  OFFICIAL_PYTHON_ARM64,
  OFFICIAL_R_ARM64,
  probeOfficialArtifacts
} from './windows-arm64-runtime-availability.mjs'

describe('Windows ARM64 runtime source probe', () => {
  it('keeps representative official Python and R artifact URLs explicit', () => {
    expect(OFFICIAL_PYTHON_ARM64.map((release) => release.minor)).toEqual(['3.11', '3.12', '3.13'])
    expect(OFFICIAL_R_ARM64.map((release) => release.minor)).toEqual(['4.3', '4.4'])
    expect(OFFICIAL_PYTHON_ARM64.every((release) => release.installer.includes('arm64'))).toBe(true)
    expect(OFFICIAL_R_ARM64.every((release) => release.installer.includes('aarch64'))).toBe(true)
  })

  it('reports installer and embeddable availability independently', async () => {
    const fetchImpl = async (url: string) =>
      ({
        ok: !url.includes('3.11.9-arm64.exe') && !url.includes('4.3.3-aarch64.exe'),
        status: url.includes('3.11.9-arm64.exe') || url.includes('4.3.3-aarch64.exe') ? 404 : 200
      }) as Response
    const report = await probeOfficialArtifacts(fetchImpl)
    expect(report.python['3.11'].installer.available).toBe(false)
    expect(report.python['3.11'].embeddable.available).toBe(true)
    expect(report.python['3.12'].installer.available).toBe(true)
    expect(report.r['4.3'].installer.available).toBe(false)
    expect(report.r['4.4'].installer.available).toBe(true)
  })
})
