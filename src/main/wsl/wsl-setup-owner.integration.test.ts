import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { probeWindowsVolume } from './windows-volume-probe'
import { WslSetupOwner } from './wsl-setup-owner'

const enabled =
  process.platform === 'win32' && process.env.OPEN_SCIENCE_WSL_SETUP_INTEGRATION === '1'
const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
const user = process.env.OPEN_SCIENCE_WSL_USER

describe.runIf(enabled)('WSL setup owner real Windows profile', () => {
  let workspace = ''

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'open-science-wsl-probe-'))
  })

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true })
  })

  it('probes the host through the production runner and validates the selected profile', async () => {
    expect(Boolean(distro), 'Set both WSL distro and user, or neither').toBe(Boolean(user))
    const owner = new WslSetupOwner({
      workspacePath: workspace,
      volumeProbe: probeWindowsVolume,
      readSelection: async () => (distro && user ? { distro, user } : undefined),
      writeSelection: async () => {
        throw new Error('Read-only verification must not persist a profile')
      }
    })

    const snapshot = await owner.probe()
    expect(snapshot.state, JSON.stringify(snapshot)).toBe(distro ? 'ready' : 'distro-required')
    expect(snapshot.distros.some((entry) => /^docker-desktop(?:-data)?$/i.test(entry.name))).toBe(
      false
    )
    if (distro) {
      expect(snapshot.readiness).toMatchObject({
        wsl2: true,
        home: true,
        bash: true,
        bwrap: true,
        python3: true,
        mirroredNetworking: true,
        namespaces: true,
        localWorkspace: true
      })
    }
  }, 90_000)
})
