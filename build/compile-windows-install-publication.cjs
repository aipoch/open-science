/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Compile for Windows PowerShell 5.1's .NET Framework, not the build host's modern .NET SDK.
// Invoke csc directly: CodeDOM's compiler launch loses Unicode environment paths.
// Pass several sources to compile them into one assembly; `options` builds the console helper.
module.exports = (source, destination, options = {}) => {
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework/v4.0.30319/csc.exe'
  )
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  // Never let a failed build reuse an older helper.
  fs.rmSync(destination, { force: true })
  execFileSync(
    compiler,
    [
      '/nologo',
      `/target:${options.target ?? 'library'}`,
      '/platform:anycpu',
      ...(options.target && options.warnAsError !== false ? ['/warnaserror'] : []),
      ...(options.references ?? []).map((reference) => `/reference:${reference}`),
      ...(options.defines ?? []).map((define) => `/define:${define}`),
      `/out:${destination}`,
      ...[source].flat()
    ],
    {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 30_000
    }
  )
}

// The uninstall helper reuses InstallDirectory from the publication helper source.
// `publicationSource` lets a test compile an injected copy of that source instead. Fault injection
// deliberately leaves assigned variables unread, so those builds opt out of /warnaserror.
module.exports.uninstallHelper = (
  destination,
  defines = [],
  publicationSource,
  warnAsError = true
) =>
  module.exports(
    [
      path.join(__dirname, 'windows-uninstall-helper.cs'),
      publicationSource ?? path.join(__dirname, 'windows-install-publication.cs')
    ],
    destination,
    { target: 'exe', references: ['System.Web.Extensions.dll'], defines, warnAsError }
  )

// Replaces the install-path PowerShell scripts. Same sources as the uninstall helper plus the
// publication and extraction entry points, so one process covers prepare, extract, publish and
// cleanup instead of a powershell.exe launch per phase.
module.exports.installHelper = (destination, defines = []) =>
  module.exports(
    [
      path.join(__dirname, 'windows-install-helper.cs'),
      path.join(__dirname, 'windows-install-publication.cs')
    ],
    destination,
    { target: 'exe', references: ['System.Web.Extensions.dll'], defines }
  )
