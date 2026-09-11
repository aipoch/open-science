import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const darwinHelper = fileURLToPath(new URL('./darwin-metadata.py', import.meta.url))
export function repairDarwinMetadata(from, to) {
  execFileSync('python3', [darwinHelper, 'repair', from, to], { stdio: 'pipe' })
}
// Existing unprefixed receipts retain their exact, legacy comparison, including provenance.
export const metadataFormat = (expected) =>
  expected?.startsWith('darwin-v2:') ? 'darwin-v2' : 'legacy'

// Copy success is not metadata proof. Compare the platform's ACL/xattr representation as well.
// Linux requires the standard acl/attr tools; missing tools stop before originals are renamed.
export function metadataDigest(root, format = 'darwin-v2') {
  const run = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC', BRAND_MIGRATION_METADATA_ROOT: root },
      windowsHide: true
    }).replaceAll(root, '<root>')
  let metadata
  if (process.platform === 'darwin') {
    const listing = run('/bin/ls', ['-lneAR', root])
    let directory = '<root>'
    let current = ''
    const acl = []
    for (const line of listing.split('\n')) {
      if (line.endsWith(':') && !line.startsWith(' ')) directory = line.slice(0, -1)
      else if (/^\s+\d+:/.test(line)) acl.push([directory, current, line.trim()])
      else {
        const entry = line.match(/^\S+\s+\d+\s+\d+\s+\d+\s+\d+\s+\w+\s+\d+\s+[\d:]+\s+(.*)$/)
        if (entry) current = entry[1].split(' -> ')[0]
      }
    }
    const rootAcl = run('/bin/ls', ['-ldne', root])
      .split('\n')
      .filter((line) => /^\s+\d+:/.test(line))
    metadata =
      JSON.stringify({ acl, rootAcl }) +
      (format === 'legacy'
        ? run('/usr/bin/xattr', ['-rlxs', root])
        : run('python3', [darwinHelper, 'inspect', root]))
  } else if (process.platform === 'linux') {
    // Inspect links themselves: staged aliases can intentionally point at roots not yet published.
    metadata =
      run('getfacl', ['-R', '-P', '-p', '-n', '--', root]) +
      run('getfattr', ['-R', '-P', '-h', '-d', '-m-', '-e', 'hex', '--absolute-names', '--', root])
  } else {
    metadata = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
      $ErrorActionPreference = 'Stop'
      $migrationRoot = $env:BRAND_MIGRATION_METADATA_ROOT
      $nodes = @((Get-Item -LiteralPath $migrationRoot -Force)) + @(Get-ChildItem -LiteralPath $migrationRoot -Recurse -Force)
      $nodes | Sort-Object FullName | ForEach-Object {
        $node = $_
        $acl = Get-Acl -LiteralPath $node.FullName
        [ordered]@{ path=$node.FullName.Substring($migrationRoot.Length); sddl=$acl.Sddl } | ConvertTo-Json -Compress
        if (!$node.PSIsContainer -and !($node.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
          Get-Item -LiteralPath $node.FullName -Stream * | Where-Object Stream -ne ':$DATA' | ForEach-Object {
            $streamPath = $node.FullName + ':' + $_.Stream
            [ordered]@{ stream=$_.Stream; hash=(Get-FileHash -LiteralPath $streamPath -Algorithm SHA256).Hash } | ConvertTo-Json -Compress
          }
        }
      }
    `
    ])
  }
  return (
    (process.platform === 'darwin' && format !== 'legacy' ? 'darwin-v2:' : '') +
    createHash('sha256').update(metadata).digest('hex')
  )
}
