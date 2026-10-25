// Diagnostic only: repackage the signed Q payload with the previous single extractor.
// Never used by release builds unless explicitly selected by the signing dry-run.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Standalone CommonJS build diagnostic. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

async function main() {
  const root = path.resolve(__dirname, '..')
  const local = process.argv.includes('--unsigned-local')
  const qDir = path.resolve(process.env.COMPARISON_Q_DIR || path.join(root, 'dist'))
  const pDir = path.resolve(
    process.env.COMPARISON_P_DIR || path.join(root, 'dist/single-extractor')
  )
  const source = path.join(pDir, 'control-source')
  const evidence = path.join(pDir, 'evidence')
  const sevenZip = path.join(process.env.ProgramFiles || 'C:/Program Files', '7-Zip', '7z.exe')
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const fileHash = async (file) => hash(await fs.readFile(file))
  const run = (file, args) =>
    execFileSync(file, args, { cwd: root, windowsHide: true, stdio: 'inherit' })
  assert.equal(process.platform, 'win32')
  if (!local) assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  await fs.mkdir(pDir) // Refuse stale evidence/output reuse.
  await fs.mkdir(source)
  await fs.mkdir(evidence)
  const candidates = (await fs.readdir(qDir)).filter((name) => name.endsWith('-win-x64-setup.exe'))
  assert.equal(candidates.length, 1)
  const qInstaller = path.join(qDir, candidates[0])
  const payload = path.join(qDir, 'win-unpacked')
  const qHashBefore = await fileHash(qInstaller)
  const snapshot = async (directory, prefix = '') => {
    const files = []
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), `Unexpected link: ${entry.name}`)
      const relative = prefix + entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) files.push(...(await snapshot(absolute, relative + '/')))
      else {
        assert(entry.isFile())
        files.push({
          path: relative,
          size: (await fs.stat(absolute)).size,
          sha256: await fileHash(absolute)
        })
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }
  const before = await snapshot(payload)
  // Remove only Q's compile-time selectors, embedded lists, and parallel extraction call.
  const qSource = (
    await fs.readFile(path.join(root, 'build/windows-install-publication.nsh'), 'utf8')
  ).replace(/\r\n/g, '\n')
  let publication = qSource
  const generationStart = publication.indexOf('\n!ifdef APP_64\n')
  const variables = publication.indexOf('\nVar publicationDirectory')
  assert(generationStart > 0 && variables > generationStart)
  publication = publication.slice(0, generationStart) + publication.slice(variables)
  publication = publication.replace(
    /^ {6}File \/oname=\$PLUGINSDIR\\(?:windows-extract-payload\.ps1|all-files\.txt|all-directories\.txt|files-2-[01]\.txt).*\n/gm,
    ''
  )
  const extractionStart = publication.indexOf('  !ifdef APP_64\n    ${If} ${IsNativeAMD64}\n')
  const extractionEnd = publication.indexOf('  Pop $publicationResult\n', extractionStart)
  assert(extractionStart > 0 && extractionEnd > extractionStart)
  publication =
    publication.slice(0, extractionStart) +
    '  nsExec::ExecToStack \'"$PLUGINSDIR\\7za.exe" x -y -bd -bso0 -bsp0 -bse1 "-o$publicationDirectory" "${FILE}"\'\n' +
    publication.slice(extractionEnd)
  // This digest is the normalized previous formal implementation at be291419ca.
  await fs.writeFile(path.join(source, 'publication.nsh'), publication)
  assert.equal(
    hash(publication),
    '4fcaafbc3715a54e77d8f118f6618716f1b6c7b5f7fd632965e4fa35ae84c019'
  )
  for (const [file, from, to] of [
    ['installer.nsh', 'windows-install-publication.nsh', 'publication.nsh'],
    ['installer-license.nsh', 'installer.nsh', 'installer.nsh']
  ]) {
    const text = await fs.readFile(path.join(root, 'build', file), 'utf8')
    const needle = '!include "${BUILD_RESOURCES_DIR}\\' + from + '"'
    assert.equal(text.split(needle).length, 2)
    await fs.writeFile(
      path.join(source, file),
      text.replace(needle, () => '!include "' + path.join(source, to) + '"')
    )
  }
  const args = [
    path.join(root, 'node_modules/electron-builder/cli.js'),
    '--prepackaged',
    payload,
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    '-c.directories.output=' + pDir,
    '-c.nsis.packElevateHelper=false',
    '-c.nsis.include=' + path.join(source, 'installer-license.nsh')
  ]
  if (!local) {
    args.push('-c.win.forceCodeSigning=true')
    for (const [key, variable] of Object.entries({
      publisherName: 'AZURE_SIGNING_PUBLISHER',
      endpoint: 'AZURE_SIGNING_ENDPOINT',
      codeSigningAccountName: 'AZURE_SIGNING_ACCOUNT',
      certificateProfileName: 'AZURE_SIGNING_PROFILE'
    })) {
      assert(process.env[variable], `Missing ${variable}`)
      args.push('-c.win.azureSignOptions.' + key + '=' + process.env[variable])
    }
  } else process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  run(process.execPath, args)
  assert.deepEqual(await snapshot(payload), before, 'P repack changed the signed Q payload')
  assert.equal(await fileHash(qInstaller), qHashBefore)
  const pInstaller = path.join(pDir, candidates[0])
  const archives = []
  for (const [variant, installer] of [
    ['Q', qInstaller],
    ['P', pInstaller]
  ]) {
    const extracted = path.join(evidence, variant)
    run(sevenZip, [
      'x',
      '-tNSIS',
      '-y',
      '-o' + extracted,
      installer,
      '$PLUGINSDIR/app-64.7z',
      '$PLUGINSDIR/7za.exe',
      '$PLUGINSDIR/windows-install-publication.dll'
    ])
    archives.push(await fileHash(path.join(extracted, '$PLUGINSDIR/app-64.7z')))
  }
  assert.equal(archives[0], archives[1], 'P and Q application archives differ')
  for (const name of ['7za.exe', 'windows-install-publication.dll'])
    assert.equal(
      await fileHash(path.join(evidence, 'P/$PLUGINSDIR', name)),
      await fileHash(path.join(evidence, 'Q/$PLUGINSDIR', name))
    )
  if (!local)
    run('pwsh', [
      '-NoProfile',
      '-File',
      'scripts/ci/verify-windows-signature.ps1',
      '-InstallerDir',
      pDir
    ])
  const result = {
    status: 'PASS',
    mode: local ? 'unsigned-local' : 'azure-signed',
    sourceRevision: process.env.GITHUB_SHA || null,
    archiveSha256: archives[0],
    qInstallerSha256: qHashBefore,
    pInstallerSha256: await fileHash(pInstaller),
    payloadUnchanged: true,
    extractorBytesIdentical: true,
    files: before.length
  }
  await fs.writeFile(path.join(pDir, 'comparison.json'), JSON.stringify(result, null, 2))
  await fs.writeFile(path.join(pDir, 'inventory.json'), JSON.stringify(before, null, 2))
  console.log(JSON.stringify(result))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
