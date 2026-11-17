import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runUninstallHelper } from './fixtures/windows-uninstall-helper'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Notebook uninstall host invocation', () => {
  it.each(['missing', 'empty'])('does not elevate for %s ownership state', (state) => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-empty-'))
    roots.push(root)
    const configRoot = join(root, 'config with spaces')
    const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    if (state === 'empty') mkdirSync(ownershipRoot, { recursive: true })
    const elevationMarker = join(root, 'elevation-requested')
    const result = runUninstallWithoutElevation(configRoot, elevationMarker)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(elevationMarker)).toBe(false)
  })

  it.each(['receipt.json', 'creating.json'])(
    'preserves invalid %s and fails without elevation',
    (name) => {
      const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-invalid-'))
      roots.push(root)
      const configRoot = join(root, 'config')
      const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
      mkdirSync(ownershipRoot, { recursive: true })
      const record = join(ownershipRoot, name)
      writeFileSync(record, '{invalid')
      const elevationMarker = join(root, 'elevation-requested')
      const result = runUninstallWithoutElevation(configRoot, elevationMarker)
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Notebook isolation preparation exited')
      expect(existsSync(record)).toBe(true)
      expect(existsSync(elevationMarker)).toBe(false)
    }
  )

  it('does not treat unknown ownership content as an empty profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-unknown-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    mkdirSync(ownershipRoot, { recursive: true })
    const record = join(ownershipRoot, 'unknown-state.json')
    writeFileSync(record, '{}')
    const elevationMarker = join(root, 'elevation-requested')
    const result = runUninstallWithoutElevation(configRoot, elevationMarker)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unexpected elevation request')
    expect(existsSync(record)).toBe(true)
    expect(existsSync(elevationMarker)).toBe(true)
  })

  it.each(['profile', 'profile with spaces'])('removes resources under %s', (profile) => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-'))
    roots.push(root)
    const host = resolve(
      `packages/notebook-network-sandbox/vendor/windows/${process.arch}/notebook-appcontainer-host.exe`
    )
    const sandboxRoot = join(root, 'sandbox')
    const hostDirectory = join(sandboxRoot, process.arch)
    mkdirSync(hostDirectory, { recursive: true })
    copyFileSync(host, join(hostDirectory, 'notebook-appcontainer-host.exe'))
    const ownershipRoot = join(root, profile, '0f3cd2a44c3d4e4e9f1e2a5b')
    // The empty fixture has no owned resources, so the host's remove command is a safe no-op.
    // "direct" keeps the serialized command line but skips UAC, so the real host validates quoting.
    const result = runUninstallHelper(['notebook-sandbox', '--sandbox-root', sandboxRoot], {
      ...process.env,
      OPEN_SCIENCE_CONFIG_ROOT: join(root, profile),
      OPEN_SCIENCE_E2E_STORAGE_ROOT: '',
      OPEN_SCIENCE_HELPER_TEST_NOT_ADMIN: '1',
      OPEN_SCIENCE_HELPER_TEST_ELEVATION: 'direct'
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(ownershipRoot)).toBe(false)
  })

  it('reports the missing host and ownership locations when cleanup cannot be retried', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-missing-host-'))
    roots.push(root)
    const sandboxRoot = join(root, 'resources', 'notebook-network-sandbox', 'windows')
    const configRoot = join(root, 'config')
    const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    mkdirSync(ownershipRoot, { recursive: true })
    writeFileSync(join(ownershipRoot, 'receipt.json'), '{}')
    const result = runUninstallHelper(['notebook-sandbox', '--sandbox-root', sandboxRoot], {
      ...process.env,
      OPEN_SCIENCE_CONFIG_ROOT: configRoot
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout).toBe(1)
    const diagnostics = result.stderr.replace(/\r?\n\s*/g, '')
    expect(diagnostics).toContain('host is missing while owned resources still require cleanup')
    expect(diagnostics).toContain(`sandboxRoot=${sandboxRoot}`)
    expect(diagnostics).toContain(`ownershipRoot=${ownershipRoot}`)
    expect(diagnostics).toContain('receipt=True')
  })
})

function runUninstallWithoutElevation(
  configRoot: string,
  elevationMarker: string
): ReturnType<typeof runUninstallHelper> {
  const sandboxRoot = join(dirname(configRoot), 'sandbox')
  const hostDirectory = join(sandboxRoot, process.arch)
  mkdirSync(hostDirectory, { recursive: true })
  copyFileSync(
    resolve(
      `packages/notebook-network-sandbox/vendor/windows/${process.arch}/notebook-appcontainer-host.exe`
    ),
    join(hostDirectory, 'notebook-appcontainer-host.exe')
  )
  // Run the complete product lifecycle with the actual native host. Select the ordinary-user
  // branch even on elevated CI; intercept UAC so no test can change real protected resources.
  return runUninstallHelper(['notebook-sandbox', '--sandbox-root', sandboxRoot], {
    ...process.env,
    OPEN_SCIENCE_CONFIG_ROOT: configRoot,
    OPEN_SCIENCE_E2E_STORAGE_ROOT: '',
    OPEN_SCIENCE_HELPER_TEST_NOT_ADMIN: '1',
    OPEN_SCIENCE_HELPER_TEST_ELEVATION: `deny:${elevationMarker}`
  })
}
