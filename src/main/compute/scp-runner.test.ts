// Tests for scp-runner.ts pure helpers.
// SystemScpRunner (the real spawner) is not tested here — it's covered by the fake-injection tests
// in compute-service.test.ts, matching the pattern used for SshRunner.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_DOWNLOAD_BYTES,
  MAX_IMPORT_BYTES,
  buildScpArgs,
  inferMimeType,
  resolveDestFilename,
  validateImportPath
} from './scp-runner'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedSshTarget } from './ssh-runner'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('size constants', () => {
  it('MAX_DOWNLOAD_BYTES is 2 GiB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })

  it('MAX_IMPORT_BYTES is 50 MB', () => {
    expect(MAX_IMPORT_BYTES).toBe(50 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------------------
// validateImportPath
// ---------------------------------------------------------------------------

describe('validateImportPath', () => {
  it('accepts an absolute path without glob chars', () => {
    expect(validateImportPath('/home/user/data.csv')).toBeUndefined()
  })

  it('rejects a relative path', () => {
    expect(validateImportPath('data.csv')).toBe('outside_roots')
  })

  it('rejects a path with * glob', () => {
    expect(validateImportPath('/home/user/*.csv')).toBe('outside_roots')
  })

  it('rejects a path with ? glob', () => {
    expect(validateImportPath('/home/user/file?.csv')).toBe('outside_roots')
  })

  it('rejects a path with [ glob', () => {
    expect(validateImportPath('/home/user/[abc].csv')).toBe('outside_roots')
  })

  it('rejects a path with { glob', () => {
    expect(validateImportPath('/home/user/{a,b}.csv')).toBe('outside_roots')
  })

  it('accepts a path with spaces', () => {
    expect(validateImportPath('/home/user/my file.csv')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildScpArgs
// ---------------------------------------------------------------------------

describe('buildScpArgs', () => {
  const target: ResolvedSshTarget = {
    sshBinary: '/usr/bin/ssh',
    host: 'biowulf.nih.gov',
    extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
  }

  it('builds a basic scp arg list', () => {
    const args = buildScpArgs(target, '/remote/data.csv', '/local/data.csv')
    expect(args).toContain('-o')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('biowulf.nih.gov:/remote/data.csv')
    expect(args).toContain('/local/data.csv')
  })

  it('translates -p <port> to -o Port=<port>', () => {
    const targetWithPort: ResolvedSshTarget = {
      sshBinary: '/usr/bin/ssh',
      host: 'biowulf.nih.gov',
      extraArgs: ['-o', 'BatchMode=yes', '-p', '2222']
    }
    const args = buildScpArgs(targetWithPort, '/remote/data.csv', '/local/data.csv')
    expect(args).not.toContain('-p')
    expect(args).toContain('Port=2222')
  })

  it('passes ControlMaster args through unchanged', () => {
    const targetWithMux: ResolvedSshTarget = {
      sshBinary: '/usr/bin/ssh',
      host: 'biowulf.nih.gov',
      extraArgs: [
        '-o',
        'ControlMaster=auto',
        '-o',
        'ControlPath=/home/user/.ssh/ctrl/%r@%h:%p.biowulf',
        '-o',
        'ControlPersist=60'
      ]
    }
    const args = buildScpArgs(targetWithMux, '/remote/data.csv', '/tmp/data.csv')
    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain('ControlPersist=60')
  })

  it('places remoteSpec before localPath', () => {
    const args = buildScpArgs(target, '/remote/file.txt', '/tmp/file.txt')
    const remoteIdx = args.indexOf('biowulf.nih.gov:/remote/file.txt')
    const localIdx = args.indexOf('/tmp/file.txt')
    expect(remoteIdx).toBeLessThan(localIdx)
    expect(remoteIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeGreaterThan(-1)
  })
})

// ---------------------------------------------------------------------------
// inferMimeType
// ---------------------------------------------------------------------------

describe('inferMimeType', () => {
  it('returns text/csv for .csv', () => {
    expect(inferMimeType('data.csv')).toBe('text/csv')
  })

  it('returns application/json for .json', () => {
    expect(inferMimeType('config.json')).toBe('application/json')
  })

  it('returns image/png for .png', () => {
    expect(inferMimeType('image.png')).toBe('image/png')
  })

  it('returns application/pdf for .pdf', () => {
    expect(inferMimeType('report.pdf')).toBe('application/pdf')
  })

  it('returns application/octet-stream for unknown extension', () => {
    expect(inferMimeType('data.xyz')).toBe('application/octet-stream')
  })

  it('returns application/octet-stream for no extension', () => {
    expect(inferMimeType('datafile')).toBe('application/octet-stream')
  })

  it('is case-insensitive (uppercased extension)', () => {
    expect(inferMimeType('data.CSV')).toBe('text/csv')
  })

  it('returns application/x-ipynb+json for .ipynb', () => {
    expect(inferMimeType('notebook.ipynb')).toBe('application/x-ipynb+json')
  })
})

// ---------------------------------------------------------------------------
// resolveDestFilename
// ---------------------------------------------------------------------------

describe('resolveDestFilename', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scp-runner-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the base name when no collision', async () => {
    const name = await resolveDestFilename(tmpDir, 'data.csv')
    expect(name).toBe('data.csv')
  })

  it('appends (1) when base name already exists', async () => {
    await writeFile(join(tmpDir, 'data.csv'), '')
    const name = await resolveDestFilename(tmpDir, 'data.csv')
    expect(name).toBe('data (1).csv')
  })

  it('appends (2) when (1) also exists', async () => {
    await writeFile(join(tmpDir, 'data.csv'), '')
    await writeFile(join(tmpDir, 'data (1).csv'), '')
    const name = await resolveDestFilename(tmpDir, 'data.csv')
    expect(name).toBe('data (2).csv')
  })

  it('handles files without extension', async () => {
    await writeFile(join(tmpDir, 'README'), '')
    const name = await resolveDestFilename(tmpDir, 'README')
    expect(name).toBe('README (1)')
  })
})
