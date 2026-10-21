/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Compile for Windows PowerShell 5.1's .NET Framework, not the build host's modern .NET SDK.
// Invoke csc directly: CodeDOM's compiler launch loses Unicode environment paths.
module.exports = (source, destination) => {
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework/v4.0.30319/csc.exe'
  )
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  // Never let a failed build reuse an older helper.
  fs.rmSync(destination, { force: true })
  execFileSync(
    compiler,
    ['/nologo', '/target:library', '/platform:anycpu', `/out:${destination}`, source],
    {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 30_000
    }
  )
}
