import { describe, expect, it, vi } from 'vitest'
import { assertProjectRecordLocation } from './project-record-location'
import type { ProjectFolderLocationProbe } from './project-folder-location'

const absent = async (): Promise<string> => {
  throw new Error('not present')
}
const base: ProjectFolderLocationProbe = {
  home: '/home/user',
  environment: {},
  readText: absent,
  canonicalize: async (path) => path,
  run: absent
}
const plist = (internal = true, ejectable = false): string =>
  `<key>Internal</key><${internal}/><key>Ejectable</key><${ejectable}/><key>RemovableMedia</key><false/>`

describe('new project research record location policy', () => {
  it('accepts positive macOS internal volume metadata', async () => {
    await expect(
      assertProjectRecordLocation('/work/project', {
        ...base,
        platform: 'darwin',
        run: async (command) =>
          command.endsWith('diskutil') ? plist() : '/dev/disk1 on / (apfs, local)'
      })
    ).resolves.toBeUndefined()
  })
  it.each([plist(false), plist(true, true), '<key>Internal</key><true/>', 'malformed'])(
    'rejects unsupported or incomplete metadata: %s',
    async (metadata) => {
      await expect(
        assertProjectRecordLocation('/work/project', {
          ...base,
          platform: 'darwin',
          run: async (command) =>
            command.endsWith('diskutil') ? metadata : '/dev/disk1 on / (apfs, local)'
        })
      ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    }
  )
  it('rejects known cloud roots even on an internal disk, including configured custom Dropbox roots', async () => {
    await expect(
      assertProjectRecordLocation('/work/sync/project', {
        ...base,
        platform: 'darwin',
        readText: async () => JSON.stringify({ personal: { path: '/work/sync' } }),
        run: async () => plist()
      })
    ).rejects.toThrow('cloud-synced')
  })
  it.each(['linux', 'darwin', 'win32'] as const)(
    'fails closed on unavailable %s volume evidence',
    async (platform) => {
      await expect(
        assertProjectRecordLocation('/work/project', { ...base, platform })
      ).rejects.toThrow('unknown')
    }
  )
  it('allows a slow Windows storage query and resolves only the volume containing the folder', async () => {
    const run = vi.fn(async (_command: string, args: string[], timeoutMs?: number) => {
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
      if (!script.includes('Get-Volume -FilePath') || (timeoutMs ?? 2500) < 4000)
        throw new Error('Windows storage query did not complete')
      return JSON.stringify({ driveType: 'Fixed', bus: 'SATA' })
    })

    await expect(
      assertProjectRecordLocation('D:\\research\\project', { ...base, platform: 'win32', run })
    ).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rejects a known Windows sync folder before launching a volume query', async () => {
    const run = vi.fn(base.run!)
    await expect(
      assertProjectRecordLocation('D:\\sync\\project', {
        ...base,
        platform: 'win32',
        environment: { OneDrive: 'D:\\sync' },
        run
      })
    ).rejects.toThrow('cloud-synced')
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['Fixed', 'NVMe', true],
    ['Fixed', 'SATA', true],
    ['Fixed', 'USB', false],
    ['Fixed', 'Virtual', false],
    ['Fixed', 'Unknown', false],
    ['Network', 'SATA', false],
    ['Removable', 'SATA', false]
  ])('checks Windows physical bus and volume type (%s %s)', async (driveType, bus, allowed) => {
    const result = assertProjectRecordLocation('C:\\work\\project', {
      ...base,
      platform: 'win32',
      run: async () => JSON.stringify({ driveType, bus })
    })
    if (allowed) await expect(result).resolves.toBeUndefined()
    else await expect(result).rejects.toMatchObject({ code: 'project-folder-unavailable' })
  })
  it.each([
    ['/sys/devices/pci0000:00/0000:00:01/nvme/nvme0/nvme0n1', '0', 'ext4', true],
    ['/sys/devices/pci0000:00/usb1/disk', '0', 'ext4', false],
    ['/sys/devices/pci0000:00/ata1/disk', '1', 'ext4', false],
    ['/sys/devices/virtual/block/dm-0', '0', 'ext4', false],
    ['/sys/devices/virtual/block/sda', '0', '9p', false],
    ['/sys/devices/pci0000:00/ata1/disk', '0', 'nfs', false]
  ])('checks Linux block metadata (%s %s %s)', async (device, removable, filesystem, allowed) => {
    const result = assertProjectRecordLocation('/work/project', {
      ...base,
      platform: 'linux',
      readText: async (path) =>
        path === '/proc/self/mountinfo'
          ? `20 1 8:1 / / rw - ${filesystem} /dev/sda1 rw`
          : path.endsWith('/removable')
            ? removable
            : await absent(),
      canonicalize: async (path) => (path.startsWith('/sys/dev/block/') ? device : path)
    })
    if (allowed) await expect(result).resolves.toBeUndefined()
    else await expect(result).rejects.toMatchObject({ code: 'project-folder-unavailable' })
  })
})

// Actual host check; the platform fixture cases above are not Windows/Linux integration tests.
it.skipIf(process.platform !== 'darwin' || process.env.RUN_PROJECT_RECORD_NATIVE_PROBE !== '1')(
  'probes the native macOS repository volume',
  async () => {
    await expect(assertProjectRecordLocation(process.cwd())).resolves.toBeUndefined()
  }
)
