import { VerificationProcessExitError } from './verification-process'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  DEB_ROOT_GATE_SCRIPT,
  DEB_AUTHORIZATION_SCRIPT,
  createDebSystemdGate,
  cancelDebSystemdGate,
  cancelUnclaimedDebGates,
  debUnitArguments,
  inspectDebSystemdGate,
  parseSystemdProperties,
  type DebSystemdGate
} from './deb-systemd-gate'
// Boot-query integration is covered separately; lifecycle fixtures need a stable boot.
vi.mock('../system-boot-identity', async (original) => ({
  ...(await original<typeof import('../system-boot-identity')>()),
  systemBootIdentity: () => 'windows-boot:12345678-1234-4321-8123-123456789abc'
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await fs.lstat(...args)
      // Model the trusted Linux receipt metadata without creating privileged files.
      Object.defineProperty(stat, 'uid', { value: 0 })
      Object.defineProperty(stat, 'mode', { value: 0o40755 })
      return stat
    }
  }
})
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })))
function fixture(): DebSystemdGate {
  const directory = mkdtempSync(join(tmpdir(), 'deb-gate-'))
  dirs.push(directory)
  const stateDirectory = join(directory, 'root')
  mkdirSync(stateDirectory, { mode: 0o755 })
  writeFileSync(join(stateDirectory, 'identity'), 'bound')
  return {
    directory,
    stateDirectory,
    binding: 'bound',
    nonce: randomUUID(),
    unit: 'fixture.service'
  }
}
function manager(
  fields: Record<string, string>
): ReturnType<typeof vi.fn<() => Promise<{ stdout: string; stderr: string }>>> {
  return vi.fn(async () => ({
    stdout: Object.entries({
      LoadState: 'loaded',
      ExitType: 'cgroup',
      ActiveState: 'active',
      SubState: 'running',
      MainPID: '123',
      ExecMainStatus: '0',
      ControlGroup: '',
      ...fields
    })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    stderr: ''
  }))
}
it('parses actual systemctl line feeds and preserves literal dollar paths as fixed argv', () => {
  expect(parseSystemdProperties('LoadState=loaded\nMainPID=42\n')).toEqual({
    LoadState: 'loaded',
    MainPID: '42'
  })
  const args = debUnitArguments(fixture(), '/tmp/$HOME payload.deb', 'a'.repeat(128))
  expect(args).toContain('--expand-environment=no')
  expect(args[args.indexOf('-c') + 1]).toBe(DEB_ROOT_GATE_SCRIPT)
  expect(args).toContain('/tmp/$HOME payload.deb')
  expect(args).not.toContain(process.execPath)
})
it('requires the waiting gate process alive before stopping Runtime', async () => {
  const gate = fixture()
  writeFileSync(join(gate.stateDirectory, 'state'), 'waiting')
  expect(await inspectDebSystemdGate(gate, manager({}))).toBe('waiting')
  expect(
    await inspectDebSystemdGate(
      gate,
      manager({ ActiveState: 'failed', SubState: 'failed', MainPID: '0' })
    )
  ).toBe('cancelled')
  await expect(
    inspectDebSystemdGate(
      gate,
      manager({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0' })
    )
  ).rejects.toThrow('stopped unexpectedly')
})
it('does not treat a written installed state as terminal while the unit still has children', async () => {
  const gate = fixture()
  writeFileSync(join(gate.stateDirectory, 'state'), 'installed')
  expect(await inspectDebSystemdGate(gate, manager({ MainPID: '0' }))).toBe('starting')
  expect(await inspectDebSystemdGate(gate, manager({ SubState: 'exited', MainPID: '0' }))).toBe(
    'installed'
  )
})
// The fixed Debian shell and directory fsync require a POSIX host.
it.skipIf(process.platform === 'win32').each(['cancel', 'commit', 'checksum'] as const)(
  'executes an isolated nonprivileged fixed shell gate: %s',
  async (mode) => {
    const gate = fixture()
    rmSync(gate.stateDirectory, { recursive: true })
    const archive = join(gate.directory, 'input.deb'),
      marker = join(gate.directory, 'installed')
    writeFileSync(archive, 'fixture package')
    const installer = join(gate.directory, 'fake-dpkg')
    writeFileSync(installer, `#!/bin/sh\nprintf installed > '${marker}'\n`, { mode: 0o700 })
    // Only platform bindings are substituted: the state/commit/cancel shell program is unchanged.
    const script = DEB_ROOT_GATE_SCRIPT.replace(
      'case "$root" in /var/lib/open-science-updates/????????-????-????-????-????????????) ;; *) exit 70;; esac',
      ''
    )
      .replace('mkdir -p /var/lib/open-science-updates', '')
      .replace('[ ! -L /var/lib/open-science-updates ] || exit 71', '')
      .replaceAll('sync -f "$root"', ':')
      .replaceAll('sync -f "$root/payload.deb"', ':')
      .replace('sha512sum "$root/payload.deb"', '/usr/bin/shasum -a 512 "$root/payload.deb"')
      .replace('/usr/bin/dpkg', `'${installer}'`)
    const checksum =
      mode === 'checksum'
        ? '0'.repeat(128)
        : createHash('sha512').update('fixture package').digest('hex')
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        script,
        'fixture',
        gate.stateDirectory,
        gate.directory,
        archive,
        checksum,
        gate.binding,
        gate.nonce
      ],
      { stdio: 'ignore' }
    )
    const done = new Promise<number | null>((resolve) => child.once('exit', resolve))
    try {
      if (mode !== 'checksum') {
        const deadline = Date.now() + 3000
        while (!existsSync(join(gate.stateDirectory, 'state'))) {
          if (Date.now() > deadline) throw new Error('fixture gate did not become ready')
          await new Promise((r) => setTimeout(r, 10))
        }
        expect(readFileSync(join(gate.stateDirectory, 'state'), 'utf8').trim()).toBe('waiting')
        expect(existsSync(marker)).toBe(false)
        writeFileSync(join(gate.directory, `${mode}-${gate.nonce}`), mode)
      }
      expect(await done).toBe(mode === 'checksum' ? 72 : 0)
      expect(existsSync(marker)).toBe(mode === 'commit')
      expect(readFileSync(join(gate.stateDirectory, 'state'), 'utf8').trim()).toBe(
        mode === 'cancel' ? 'cancelled' : mode === 'commit' ? 'installed' : 'rejected'
      )
    } finally {
      child.kill('SIGKILL')
      await done
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'retires a denied authorization without interpreting an arbitrary missing unit as settled',
  async () => {
    const gate = fixture(),
      directory = join(gate.directory, 'executor-denied')
    mkdirSync(directory)
    const run = vi.fn(async (command: string) => {
      if (command === '/usr/bin/pkexec') throw new VerificationProcessExitError(command, 126)
      return { stdout: 'LoadState=not-found', stderr: '' }
    })
    await expect(
      createDebSystemdGate(
        {
          directory,
          archive: join(directory, 'payload'),
          sha512: Buffer.alloc(64).toString('base64'),
          installationRoot: '/fixture/app',
          targetVersion: '2'
        },
        run
      )
    ).rejects.toThrow('exit 126')
    expect(readFileSync(join(directory, 'authorization-rejected.json'), 'utf8')).toContain(
      'binding'
    )
    await cancelUnclaimedDebGates(gate.directory, run)
    expect(existsSync(join(directory, 'deb-gate.json'))).toBe(false)
    await cancelUnclaimedDebGates(gate.directory, run)
    const ambiguous = { ...gate, unit: 'unknown.service' }
    expect(await inspectDebSystemdGate(ambiguous, manager({ LoadState: 'not-found' }))).toBe(
      'starting'
    )
    expect(DEB_AUTHORIZATION_SCRIPT).toContain('exit 200')
  }
)
it.skipIf(process.platform === 'win32')(
  'does not reobserve a settled cancellation after the transient unit disappears',
  async () => {
    const gate = fixture()
    writeFileSync(join(gate.stateDirectory, 'state'), 'cancelled')
    await cancelDebSystemdGate(gate, manager({ SubState: 'exited', MainPID: '0' }))
    const absent = manager({ LoadState: 'not-found' })
    await cancelDebSystemdGate(gate, absent)
    expect(absent).not.toHaveBeenCalled()
  }
)
