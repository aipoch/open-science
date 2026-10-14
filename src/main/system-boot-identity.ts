import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Fixed read-only OS query. No wall-clock fallback: an unknown boot cannot authorize recovery.
const WINDOWS_BOOT_ID_SCRIPT = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenScienceBootIdentity {
 [StructLayout(LayoutKind.Sequential)] public struct BootInfo { public Guid BootIdentifier; public int FirmwareType; public ulong BootFlags; }
 [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int informationClass, IntPtr information, int length, out int returned);
 public static string Read() {
  int size=Marshal.SizeOf(typeof(BootInfo)), returned; IntPtr data=Marshal.AllocHGlobal(size);
  try { int status=NtQuerySystemInformation(90,data,size,out returned); if(status!=0 || returned!=size) throw new InvalidOperationException("Kernel boot identity unavailable"); BootInfo info=(BootInfo)Marshal.PtrToStructure(data,typeof(BootInfo)); if(info.BootIdentifier==Guid.Empty) throw new InvalidOperationException("Empty kernel boot identity"); return info.BootIdentifier.ToString("D"); }
  finally { Marshal.FreeHGlobal(data); }
 }
}
'@
[OpenScienceBootIdentity]::Read()`
export function systemBootIdentity(): string {
  if (process.platform === 'linux')
    return normalizeKernelBootIdentity(
      'linux',
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
    )
  if (process.platform === 'darwin')
    return normalizeDarwinBootIdentity(
      execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 5000
      })
    )
  if (process.platform === 'win32') {
    const uuid = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOOT_ID_SCRIPT],
      { encoding: 'utf8', timeout: 5000 }
    )
      .trim()
      .toLowerCase()
    return normalizeKernelBootIdentity('windows', uuid)
  }
  throw new Error('This operating system cannot prove a system restart for legacy recovery.')
}

export type BootPlatform = 'darwin' | 'windows' | 'linux'
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function validUuid(uuid: string): boolean {
  return uuidPattern.test(uuid) && uuid !== '00000000-0000-0000-0000-000000000000'
}
export function normalizeKernelBootIdentity(platform: BootPlatform, output: string): string {
  const uuid = output.trim().toLowerCase()
  if (!validUuid(uuid)) throw new Error('The kernel boot identity could not be parsed.')
  return `${platform}-boot:${uuid}`
}
export function normalizeDarwinBootIdentity(output: string): string {
  return normalizeKernelBootIdentity('darwin', output)
}
export function isStableBootIdentity(identity: unknown): identity is string {
  if (typeof identity !== 'string') return false
  const match = /^(darwin|windows|linux)-boot:(.+)$/.exec(identity)
  return !!match && validUuid(match[2])
}
export function hasSystemRestarted(recorded: unknown, current: unknown): boolean {
  return (
    isStableBootIdentity(recorded) &&
    isStableBootIdentity(current) &&
    recorded.split(':')[0] === current.split(':')[0] &&
    recorded !== current
  )
}
export function assertSystemRestarted(recorded: unknown, current: unknown): void {
  if (
    !isStableBootIdentity(recorded) ||
    !isStableBootIdentity(current) ||
    recorded.split(':')[0] !== current.split(':')[0]
  )
    throw new Error(
      'A trustworthy kernel boot session identity is unavailable. Recovery remains protected.'
    )
  if (recorded === current) throw new Error('A confirmed system restart is required.')
}
