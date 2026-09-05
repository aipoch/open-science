import { describe, expect, it } from 'vitest'

import {
  buildManagedRuntimeProcessEnvironment,
  buildNotebookKernelEnvironment,
  buildNotebookShellEnvironment,
  environmentPathRoots,
  notebookTrustBundleEnvironment
} from './process-environment'

describe('Notebook process environment', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/researcher',
    LANG: 'en_US.UTF-8',
    API_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    JAVA_TOOL_OPTIONS: '-javaagent:unexpected.jar',
    PYTHONPATH: '/home/researcher/python',
    USERPROFILE: 'C:\\Users\\host-user',
    TEMP: 'C:\\Users\\host-user\\Temp'
  }

  it('projects a secret-free shell environment', () => {
    expect(buildNotebookShellEnvironment('/workspace/handoff', 'linux', source)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/researcher',
      LANG: 'en_US.UTF-8',
      OPEN_SCIENCE_HANDOFF_DIR: '/workspace/handoff'
    })
  })

  it('does not inherit credential or language-runtime injection hooks', () => {
    const env = buildNotebookKernelEnvironment('linux', source)

    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.API_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.JAVA_TOOL_OPTIONS).toBeUndefined()
    expect(env.PYTHONNOUSERSITE).toBeUndefined()
  })

  it('adds Python user-site isolation only for an app-managed runtime', () => {
    expect(
      buildManagedRuntimeProcessEnvironment('/runtime', {
        language: 'python',
        platform: 'linux',
        sourceEnv: { PATH: '/usr/bin', HOME: '/host' }
      })
    ).toMatchObject({ HOME: '/runtime/home', PYTHONNOUSERSITE: '1' })
  })

  it('removes inherited R library injection and selects the managed prefix library', () => {
    const env = buildManagedRuntimeProcessEnvironment('/runtime', {
      language: 'r',
      prefix: '/runtime/envs/analysis',
      platform: 'linux',
      sourceEnv: {
        R_USER: '/host',
        R_LIBS: '/host/libs',
        R_LIBS_USER: '/host/user-lib',
        R_LIBS_SITE: '/host/site-lib'
      }
    })

    expect(env).toMatchObject({
      HOME: '/runtime/home',
      R_USER: '/runtime/home',
      R_LIBS_USER: '/runtime/envs/analysis/lib/R/library'
    })
    expect(env.R_LIBS).toBeUndefined()
    expect(env.R_LIBS_SITE).toBeUndefined()
  })

  it('keeps the dedicated Windows account identity instead of overlaying the host profile', () => {
    const env = buildNotebookKernelEnvironment('win32', source)

    expect(env.USERPROFILE).toBeUndefined()
    expect(env.HOME).toBeUndefined()
    expect(env.TEMP).toBeUndefined()
  })

  it('preserves Windows system-directory metadata required by the protected launcher', () => {
    expect(
      buildNotebookKernelEnvironment('win32', {
        ...source,
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramW6432: 'C:\\Program Files'
      })
    ).toMatchObject({
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files'
    })
  })

  it('projects a custom trust bundle to native Notebook clients', () => {
    expect(notebookTrustBundleEnvironment('/certs/complete.pem')).toEqual({
      CONDA_SSL_VERIFY: '/certs/complete.pem',
      SSL_CERT_FILE: '/certs/complete.pem',
      REQUESTS_CA_BUNDLE: '/certs/complete.pem',
      PIP_CERT: '/certs/complete.pem',
      CURL_CA_BUNDLE: '/certs/complete.pem',
      NODE_EXTRA_CA_CERTS: '/certs/complete.pem'
    })
    expect(notebookTrustBundleEnvironment()).toEqual({})
  })

  it('does not turn relative PATH entries into filesystem grants', () => {
    const isDirectory = (path: string): boolean => path === '/usr/bin' || path === 'C:\\Windows'

    expect(environmentPathRoots({ PATH: '/usr/bin:./scripts:bin' }, 'linux', isDirectory)).toEqual([
      '/usr/bin'
    ])
    expect(environmentPathRoots({ PATH: 'C:\\Windows;tools' }, 'win32', isDirectory)).toEqual([
      'C:\\Windows'
    ])
  })

  it('does not project stale absolute PATH entries', () => {
    expect(
      environmentPathRoots(
        { PATH: 'C:\\Windows;C:\\Deleted\\Tools' },
        'win32',
        (path) => path === 'C:\\Windows'
      )
    ).toEqual(['C:\\Windows'])
  })
})
