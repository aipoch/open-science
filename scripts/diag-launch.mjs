// DIAGNOSTIC-ONLY: temporary branch diag/v028-startup-repro; never merge.
// Launches the app the way the Windows installer smoke does and prints everything,
// including the DIAG error lines added to src/main/index.ts on this branch.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const packaged = process.argv.includes('--packaged')
const root = process.cwd()
const profileDirectory = await mkdtemp(join(tmpdir(), 'diag-startup-profile-'))
const storageRoot = await mkdtemp(join(tmpdir(), 'diag-startup-storage-'))
const temporaryDirectory = join(profileDirectory, 'Temp')
await mkdir(temporaryDirectory, { recursive: true })

const executable = packaged
  ? resolve(root, 'dist', 'win-unpacked', 'Open Science.exe')
  : join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const args = packaged ? ['--open-science-headless', '--serve=0'] : ['.', '--open-science-headless', '--serve=0']

const env = {
  ...process.env,
  HOME: profileDirectory,
  USERPROFILE: profileDirectory,
  APPDATA: join(profileDirectory, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(profileDirectory, 'AppData', 'Local'),
  TEMP: temporaryDirectory,
  TMP: temporaryDirectory,
  OPEN_SCIENCE_E2E_STORAGE_ROOT: storageRoot,
  ELECTRON_ENABLE_LOGGING: '1'
}

await writeFile(join(profileDirectory, 'diag-env.txt'), JSON.stringify({ executable, args, storageRoot }, null, 2))
console.log(`DIAG launching: ${executable} ${args.join(' ')}`)
console.log(`DIAG storage root: ${storageRoot}`)

const child = spawn(executable, args, { env, windowsHide: true })
let output = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  output += chunk
  process.stdout.write(`[app] ${chunk}`)
})
child.stderr.on('data', (chunk) => {
  output += chunk
  process.stderr.write(`[app:err] ${chunk}`)
})

const timeout = setTimeout(() => {
  console.log('\nDIAG: still running after 120s (no startup failure reproduced); killing.')
  child.kill()
}, 120_000)

child.on('exit', (code) => {
  clearTimeout(timeout)
  console.log(`\nDIAG: app exited with code ${code}`)
  if (/DIAG (composition|startup) error/.test(output)) {
    console.log('DIAG: captured the startup error above.')
  } else {
    console.log('DIAG: no DIAG error line captured.')
  }
  process.exit(0)
})
