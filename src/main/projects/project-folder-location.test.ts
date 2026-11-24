import { describe, expect, it } from 'vitest'
import {
  detectProjectFolderWarnings,
  type ProjectFolderLocationProbe
} from './project-folder-location'

const unavailable = async (): Promise<string> => {
  throw new Error('Optional metadata unavailable')
}
const probe = (overrides: ProjectFolderLocationProbe = {}): ProjectFolderLocationProbe => ({
  platform: 'linux',
  home: '/home/researcher',
  environment: {},
  canonicalize: async (path) => path,
  readText: unavailable,
  run: unavailable,
  ...overrides
})

it('does not classify an ordinary folder from a sync-like basename alone', async () => {
  expect(await detectProjectFolderWarnings('/home/researcher/Dropbox-project', probe())).toEqual([])
})
it('recognizes configured Dropbox roots and physical aliases without prefix collisions', async () => {
  const configured = probe({
    readText: async (path) =>
      path.endsWith('/.dropbox/info.json')
        ? JSON.stringify({ personal: { path: '/home/researcher/Dropbox' } })
        : unavailable(),
    canonicalize: async (path) => (path === '/home/researcher/Dropbox' ? '/srv/sync' : path)
  })
  expect(await detectProjectFolderWarnings('/srv/sync/study', configured)).toEqual(['cloud-synced'])
  expect(await detectProjectFolderWarnings('/srv/sync-other/study', configured)).toEqual([])
})
it('recognizes OneDrive roots after canonicalization using the host path syntax', async () => {
  const options = probe({
    platform: 'win32',
    home: 'C:\\Users\\Researcher',
    environment: { OneDrive: 'C:\\Users\\Researcher\\OneDrive' }
  })
  expect(
    await detectProjectFolderWarnings('C:\\Users\\Researcher\\OneDrive\\Study', options)
  ).toEqual(['cloud-synced'])
  expect(
    await detectProjectFolderWarnings('C:\\Users\\Researcher\\OneDrive-other\\Study', options)
  ).toEqual([])
})

describe('Linux mounted location metadata', () => {
  const mountinfo = [
    '20 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
    '21 20 0:43 / /srv/cohort rw,relatime - nfs4 lab:/cohort rw',
    '22 20 8:17 / /media/researcher/My\\040USB rw,relatime - exfat /dev/sdb1 rw'
  ].join('\n')
  it('recognizes mounted network volumes without applying that risk to adjacent paths', async () => {
    const options = probe({
      readText: async (path) => (path === '/proc/self/mountinfo' ? mountinfo : unavailable())
    })
    expect(await detectProjectFolderWarnings('/srv/cohort/study', options)).toEqual(['network'])
    expect(await detectProjectFolderWarnings('/srv/cohort-copy/study', options)).toEqual([])
  })
  it('recognizes a removable parent block device for a partition and decodes mountpoint spaces', async () => {
    const options = probe({
      canonicalize: async (path) =>
        path === '/sys/dev/block/8:17' ? '/sys/devices/platform/block/mmcblk0/mmcblk0p1' : path,
      readText: async (path) =>
        path === '/proc/self/mountinfo'
          ? mountinfo
          : path === '/sys/devices/platform/block/mmcblk0/removable'
            ? '1\n'
            : unavailable()
    })
    expect(await detectProjectFolderWarnings('/media/researcher/My USB/study', options)).toEqual([
      'removable'
    ])
  })
  it('recognizes USB-attached media even when its fixed-disk removable flag is false', async () => {
    const options = probe({
      canonicalize: async (path) =>
        path === '/sys/dev/block/8:17' ? '/sys/devices/pci/usb1/1-1/block/sdb/sdb1' : path,
      readText: async (path) => (path === '/proc/self/mountinfo' ? mountinfo : unavailable())
    })
    expect(await detectProjectFolderWarnings('/media/researcher/My USB/study', options)).toEqual([
      'removable'
    ])
  })
})

describe('macOS mounted location metadata', () => {
  it('recognizes SMB and removable volumes with OS metadata', async () => {
    const options = probe({
      platform: 'darwin',
      home: '/Users/researcher',
      run: async (command) =>
        command === '/sbin/mount'
          ? '/dev/disk1s1 on / (apfs, local)\n//lab/cohort on /Volumes/Lab\\040Data (smbfs, nodev)\n/dev/disk3s1 on /Volumes/USB (apfs, local)'
          : '<plist><dict><key>Internal</key><false/><key>Ejectable</key><true/></dict></plist>'
    })
    expect(await detectProjectFolderWarnings('/Volumes/Lab Data/study', options)).toEqual([
      'network'
    ])
    expect(await detectProjectFolderWarnings('/Volumes/USB/study', options)).toEqual(['removable'])
  })
  it('keeps OS-managed iCloud/CloudStorage hints when optional volume inspection fails', async () => {
    expect(
      await detectProjectFolderWarnings(
        '/Users/researcher/Library/Mobile Documents/com~apple~CloudDocs/study',
        probe({ platform: 'darwin', home: '/Users/researcher' })
      )
    ).toEqual(['cloud-synced'])
    expect(
      await detectProjectFolderWarnings(
        '/Users/researcher/Library/CloudStorage/Dropbox/study',
        probe({ platform: 'darwin', home: '/Users/researcher' })
      )
    ).toEqual(['cloud-synced'])
  })
})

describe('Windows mounted location metadata', () => {
  it('recognizes mapped network drives from DriveInfo rather than drive-letter spelling', async () => {
    const options = probe({
      platform: 'win32',
      home: 'C:\\Users\\Researcher',
      run: async () => '{"driveType":4,"removable":false}'
    })
    expect(await detectProjectFolderWarnings('Z:\\Study', options)).toEqual(['network'])
  })
  it('recognizes removable and USB/SD media without rejecting supported filesystems', async () => {
    const options = probe({
      platform: 'win32',
      home: 'C:\\Users\\Researcher',
      run: async () => '{"driveType":2,"removable":true}'
    })
    expect(await detectProjectFolderWarnings('E:\\Study', options)).toEqual(['removable'])
  })
  it('preserves an explicit network hint when optional volume metadata is unavailable', async () => {
    expect(
      await detectProjectFolderWarnings('\\\\lab\\share\\Study', probe({ platform: 'win32' }))
    ).toEqual(['network'])
  })
})
