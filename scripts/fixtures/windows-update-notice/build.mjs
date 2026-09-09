// Build tiny real NSIS installers with the released/current product hooks and isolated identity.
// Uses the existing electron-builder installation and its normal NSIS cache; never publishes.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build, Platform, Arch } from 'electron-builder'

const root = resolve(process.argv[2])
const compiler = process.env.OPEN_SCIENCE_MAKENSIS
if (!compiler) throw new Error('Set OPEN_SCIENCE_MAKENSIS to the cached makensis.exe.')
const name = 'open-science-update-notice-test'
const guid = '11f7eae6-e7e3-4c1c-931f-2a9b1df095ea'
for (const [version, code, hook] of [
  [
    '0.25.1',
    25,
    execFileSync('git', ['show', 'v0.25.1:build/installer.nsh'], { encoding: 'utf8' })
  ],
  ['0.26.0', 26, await readFile('build/installer.nsh', 'utf8')]
]) {
  const projectDir = join(root, version)
  const packed = join(projectDir, 'packed')
  await mkdir(join(packed, 'resources'), { recursive: true })
  await writeFile(
    join(projectDir, 'package.json'),
    JSON.stringify({
      name,
      version,
      description: 'Isolated Windows update notice test',
      author: 'Open-Science'
    })
  )
  await writeFile(
    join(projectDir, 'payload.nsi'),
    [
      'Unicode true',
      'RequestExecutionLevel user',
      'SilentInstall silent',
      `OutFile "${join(packed, `${name}.exe`)}"`,
      'Section',
      `SetErrorLevel ${code}`,
      'SectionEnd'
    ].join('\n')
  )
  execFileSync(
    compiler,
    [process.platform === 'win32' ? '/V2' : '-V2', join(projectDir, 'payload.nsi')],
    { windowsHide: true }
  )
  for (const script of [
    'windows-runtime-cache-uninstall.ps1',
    'windows-notebook-sandbox-uninstall.ps1'
  ]) {
    await writeFile(join(packed, 'resources', script), 'exit 0\r\n')
  }
  await writeFile(join(projectDir, 'installer.nsh'), hook)
  await build({
    projectDir,
    prepackaged: packed,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never',
    config: {
      appId: `com.aipoch.test.${name}`,
      productName: name,
      electronVersion: '39.8.10',
      npmRebuild: false,
      directories: { output: join(projectDir, 'dist') },
      win: { executableName: name, signAndEditExecutable: false },
      nsis: {
        guid,
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        runAfterFinish: false,
        packElevateHelper: false,
        include: join(projectDir, 'installer.nsh'),
        artifactName: 'notice-fixture-installer.exe'
      }
    }
  })
}
