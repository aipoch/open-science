/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

module.exports = (destination) => {
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework/v4.0.30319/csc.exe'
  )
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.rmSync(destination, { force: true })
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/reference:System.Web.Extensions.dll',
      `/out:${destination}`,
      path.join(__dirname, 'windows-installation-processes.cs')
    ],
    { windowsHide: true, stdio: 'pipe', timeout: 30_000 }
  )
}
