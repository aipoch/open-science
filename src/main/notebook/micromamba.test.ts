import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  caBundleEnv,
  createFromLockArgv,
  createFromPackagesArgv,
  installFromLockArgv,
  installArgv,
  micromambaSpawnEnv,
  normalizeExplicitLock,
  resolveMicromamba
} from './micromamba'

describe('micromamba argv builders', () => {
  it('createFromLockArgv is the offline unified form (no channel)', () => {
    const argv = createFromLockArgv(
      '/mm',
      '/root',
      '/root/envs/default-python',
      '/res/default-python.lock'
    )
    expect(argv).toEqual([
      '/mm',
      '--no-rc',
      'create',
      '-p',
      '/root/envs/default-python',
      '--file',
      '/res/default-python.lock',
      '--offline',
      '-y',
      '--root-prefix',
      '/root'
    ])
    expect(argv.join(' ')).not.toContain('conda-forge')
  })

  it('createFromPackagesArgv is the online channel form with packages last', () => {
    const argv = createFromPackagesArgv(
      '/mm',
      '/root',
      '/root/envs/default-r',
      ['conda-forge'],
      ['r-base', 'r-irkernel']
    )
    expect(argv).toEqual([
      '/mm',
      '--no-rc',
      'create',
      '--root-prefix',
      '/root',
      '--prefix',
      '/root/envs/default-r',
      '-y',
      '-c',
      'conda-forge',
      'r-base',
      'r-irkernel'
    ])
    expect(argv.join(' ')).not.toContain('--offline')
  })

  it('expands multiple channels into repeated -c flags in priority order', () => {
    const argv = installArgv(
      '/mm',
      '/root',
      '/p',
      ['conda-forge', 'bioconda'],
      ['bioconductor-deseq2']
    )
    // conda-forge listed first (highest strict priority), bioconda next.
    expect(argv.join(' ')).toContain('-c conda-forge -c bioconda bioconductor-deseq2')
  })

  it('installArgv is the additive form', () => {
    const argv = installArgv(
      '/mm',
      '/root',
      '/root/envs/default-python',
      ['conda-forge'],
      ['openpyxl']
    )
    expect(argv).toEqual([
      '/mm',
      '--no-rc',
      'install',
      '--root-prefix',
      '/root',
      '--prefix',
      '/root/envs/default-python',
      '-y',
      '-c',
      'conda-forge',
      'openpyxl'
    ])
  })

  it('installFromLockArgv applies an exact lock additively without a channel solve', () => {
    const argv = installFromLockArgv(
      '/mm',
      '/root',
      '/root/envs/default-python',
      '/root/packs/2/linux-64/python-3.12/python-3.12.lock'
    )
    expect(argv).toEqual([
      '/mm',
      '--no-rc',
      'install',
      '-p',
      '/root/envs/default-python',
      '--file',
      '/root/packs/2/linux-64/python-3.12/python-3.12.lock',
      '--offline',
      '-y',
      '--root-prefix',
      '/root'
    ])
    expect(argv).not.toContain('-c')
  })
})

describe('normalizeExplicitLock', () => {
  it('prepends @EXPLICIT and keeps only package URL lines', () => {
    const raw = [
      '# This file may be used to create an environment using:',
      '# platform: osx-arm64',
      'https://conda.anaconda.org/conda-forge/noarch/numpy-1.0.conda#abc123',
      '  https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.conda#def456  ',
      'not a url line'
    ].join('\n')
    expect(normalizeExplicitLock(raw)).toBe(
      [
        '@EXPLICIT',
        'https://conda.anaconda.org/conda-forge/noarch/numpy-1.0.conda#abc123',
        'https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.conda#def456'
      ].join('\n') + '\n'
    )
  })

  it('handles input with no url lines', () => {
    expect(normalizeExplicitLock('# nothing here\n')).toBe('@EXPLICIT\n')
  })

  it('handles empty input', () => {
    expect(normalizeExplicitLock('')).toBe('@EXPLICIT\n')
  })
})

describe('resolveMicromamba', () => {
  it('prefers the OPEN_SCIENCE_MICROMAMBA_BIN override when it is a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'os-mm-'))
    const bin = join(dir, 'micromamba')
    writeFileSync(bin, 'x')
    expect(resolveMicromamba({ env: { OPEN_SCIENCE_MICROMAMBA_BIN: bin } })).toBe(bin)
  })

  it('ignores the override when it does not point at a real file', () => {
    const resources = mkdtempSync(join(tmpdir(), 'os-res-'))
    const name = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'
    writeFileSync(join(resources, name), 'x')
    expect(
      resolveMicromamba({
        env: { OPEN_SCIENCE_MICROMAMBA_BIN: '/no/such/bin' },
        resourcesPath: resources
      })
    ).toBe(join(resources, name))
  })

  it('falls back to the bundled resource binary', () => {
    const resources = mkdtempSync(join(tmpdir(), 'os-res-'))
    const name = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'
    writeFileSync(join(resources, name), 'x')
    expect(resolveMicromamba({ env: {}, resourcesPath: resources })).toBe(join(resources, name))
  })

  it('falls back to the storage-root runtime binary under home', () => {
    const home = mkdtempSync(join(tmpdir(), 'os-home-'))
    const name = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'
    const runtimeDir = join(home, '.open-science', 'runtime', 'micromamba', 'bin')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, name), 'x')
    expect(resolveMicromamba({ env: {}, resourcesPath: '/no/such/dir', home })).toBe(
      join(runtimeDir, name)
    )
  })

  it('falls back to PATH when nothing else resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'os-path-'))
    const name = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'
    writeFileSync(join(dir, name), 'x')
    expect(
      resolveMicromamba({
        env: { PATH: dir },
        resourcesPath: '/no/such/dir',
        home: '/no/such/home'
      })
    ).toBe(join(dir, name))
  })

  it('returns undefined when nothing resolves', () => {
    expect(
      resolveMicromamba({ env: {}, resourcesPath: '/no/such/dir', home: '/no/such/home' })
    ).toBeUndefined()
  })
})

describe('caBundleEnv', () => {
  it('fans one PEM path out to every download tool CA var', () => {
    expect(caBundleEnv('/ca.pem')).toEqual({
      CONDA_SSL_VERIFY: '/ca.pem',
      SSL_CERT_FILE: '/ca.pem',
      REQUESTS_CA_BUNDLE: '/ca.pem',
      PIP_CERT: '/ca.pem',
      CURL_CA_BUNDLE: '/ca.pem'
    })
  })

  it('is empty when no bundle is set', () => {
    expect(caBundleEnv(undefined)).toEqual({})
    expect(caBundleEnv('')).toEqual({})
  })
})

describe('micromambaSpawnEnv', () => {
  it('cleans inherited conda/mamba values before injecting the Windows app cache and CA vars', () => {
    const env = micromambaSpawnEnv('D:\\OpenScience\\runtime', '/ca.pem', {
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows',
        CONDA_PKGS_DIRS: 'Z:\\hostile-cache',
        conda_prefix: 'Z:\\foreign-env',
        MAMBA_ROOT_PREFIX: 'Z:\\foreign-root',
        SSL_CERT_FILE: 'Z:\\old-ca'
      },
      selectCache: () => ({ path: 'D:\\osp1234567890', lockKey: 'd:\\osp1234567890' })
    })

    expect(env).toMatchObject({
      PATH: 'C:\\Windows',
      CONDA_PKGS_DIRS: 'D:\\osp1234567890',
      CONDA_SSL_VERIFY: '/ca.pem',
      SSL_CERT_FILE: '/ca.pem',
      REQUESTS_CA_BUNDLE: '/ca.pem',
      PIP_CERT: '/ca.pem',
      CURL_CA_BUNDLE: '/ca.pem'
    })
    expect(env.conda_prefix).toBeUndefined()
    expect(env.MAMBA_ROOT_PREFIX).toBeUndefined()
  })

  it('leaves inherited non-Windows environment behavior unchanged apart from CA injection', () => {
    const env = micromambaSpawnEnv('/runtime', '/ca.pem', {
      platform: 'darwin',
      env: { CONDA_PKGS_DIRS: '/existing', MAMBA_ROOT_PREFIX: '/existing-root' }
    })

    expect(env.CONDA_PKGS_DIRS).toBe('/existing')
    expect(env.MAMBA_ROOT_PREFIX).toBe('/existing-root')
    expect(env.CONDA_SSL_VERIFY).toBe('/ca.pem')
  })
})
