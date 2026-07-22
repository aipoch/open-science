import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  formatBytes,
  isNewer,
  platformDownloadKey,
  selectDownload,
  type UpdateManifest
} from './update'

const manifest: UpdateManifest = {
  version: '0.3.0',
  releaseDate: '',
  notes: 'notes',
  downloads: {
    'mac-arm64': { url: 'https://cdn/x-mac-arm64.dmg', size: 10, sha256: 'a' },
    'win-x64': { url: 'https://cdn/x-win.exe', size: 20, sha256: 'b' },
    'linux-x64-appimage': { url: 'https://cdn/x.AppImage', size: 30, sha256: 'c' }
  }
}

describe('compareVersions', () => {
  it('orders by numeric component', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1)
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })
})

describe('isNewer', () => {
  it('is true only when latest exceeds current', () => {
    expect(isNewer('0.3.0', '0.2.0')).toBe(true)
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
  })
})

describe('platformDownloadKey', () => {
  it('maps platform+arch to a manifest key', () => {
    expect(platformDownloadKey('darwin', 'arm64')).toBe('mac-arm64')
    expect(platformDownloadKey('darwin', 'x64')).toBe('mac-x64')
    expect(platformDownloadKey('win32', 'x64')).toBe('win-x64')
    expect(platformDownloadKey('linux', 'x64')).toBe('linux-x64-deb')
    expect(platformDownloadKey('freebsd' as NodeJS.Platform, 'x64')).toBeNull()
  })
})

describe('selectDownload', () => {
  it('returns the matching entry', () => {
    expect(selectDownload(manifest, 'darwin', 'arm64')?.url).toContain('mac-arm64')
  })
  it('falls back to appimage on linux when deb is absent', () => {
    expect(selectDownload(manifest, 'linux', 'x64')?.url).toContain('AppImage')
  })
  it('returns null when no entry matches', () => {
    expect(selectDownload(manifest, 'darwin', 'x64')).toBeNull()
  })
})

describe('formatBytes', () => {
  it('formats bytes below 1 KB as-is', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })
  it('formats KB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })
  it('formats MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(12.5 * 1024 * 1024)).toBe('12.5 MB')
  })
  it('formats GB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })
})
