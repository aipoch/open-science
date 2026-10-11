import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { resolveWindowsPowerShellExecutable } from './windows-powershell'

// Both host builds bind this to the release signing configuration. Runtime environment variables
// must not select who is trusted to replace a pinned executable.
declare const __OPEN_SCIENCE_WINDOWS_SIGNING_PUBLISHER__: string | null | undefined
const buildPublisher =
  typeof __OPEN_SCIENCE_WINDOWS_SIGNING_PUBLISHER__ === 'undefined'
    ? undefined
    : __OPEN_SCIENCE_WINDOWS_SIGNING_PUBLISHER__
const execute = promisify(execFile)

type SignatureEvidence = {
  status: string
  publisher: string
  timestamped: boolean
}

export const createWindowsExecutableVerifier = (
  options: {
    expectedPublisher?: string
    env?: NodeJS.ProcessEnv
    execute?: typeof execute
  } = {}
): ((path: string) => Promise<void>) => {
  const expectedPublisher = (options.expectedPublisher ?? buildPublisher)?.trim()
  return async (path) => {
    if (!expectedPublisher)
      throw new Error('Windows executable trust requires a configured publisher.')
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(options.env ?? process.env).map(([key, value]) => [key.toUpperCase(), value])
      ),
      OPEN_SCIENCE_AUTHENTICODE_PATH: path
    }
    const windowsRoot = env.SYSTEMROOT ?? env.WINDIR
    // Do not search PATH or inherit a development host's PowerShell modules for trust decisions.
    if (!windowsRoot)
      throw new Error('Windows executable trust requires the system PowerShell path.')
    env.PSMODULEPATH = win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    env.OPEN_SCIENCE_POWERSHELL_MODULE_PATH = env.PSMODULEPATH
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$env:PSModulePath = $env:OPEN_SCIENCE_POWERSHELL_MODULE_PATH',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:OPEN_SCIENCE_AUTHENTICODE_PATH',
      '$publisher = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { "" }',
      '[PSCustomObject]@{ status = [string]$signature.Status; publisher = $publisher; timestamped = ($null -ne $signature.TimeStamperCertificate) } | ConvertTo-Json -Compress'
    ].join('; ')
    const { stdout } = await (options.execute ?? execute)(
      resolveWindowsPowerShellExecutable({ SystemRoot: windowsRoot }),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true, env, encoding: 'utf8' }
    )
    const evidence = JSON.parse(String(stdout).trim()) as Partial<SignatureEvidence> | null
    if (evidence?.status !== 'Valid') throw new Error('Invalid Authenticode signature status.')
    if (
      typeof evidence.publisher !== 'string' ||
      evidence.publisher.toLowerCase() !== expectedPublisher.toLowerCase()
    ) {
      throw new Error('Unexpected Authenticode publisher.')
    }
    if (evidence.timestamped !== true) throw new Error('Missing Authenticode timestamp.')
  }
}
