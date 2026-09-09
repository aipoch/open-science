import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runMigration } from './transaction.mjs'

export async function main(argv = process.argv.slice(2)) {
  const options = { home: homedir(), mode: 'packaged', maps: [] }
  const values = {
    '--home': 'home',
    '--app-data': 'appData',
    '--mode': 'mode',
    '--config-root': 'configRoot',
    '--user-data': 'userData',
    '--state-dir': 'stateDir',
    '--data-parent': 'dataParent',
    '--local-app-data': 'localAppData'
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (values[flag]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`)
      options[values[flag]] = argv[++i]
    } else if (flag === '--temp-parent') {
      ;(options.tempParents ??= []).push(argv[++i])
    } else if (flag === '--startup-owner') {
      options.startupOwner = Number(argv[++i])
      if (!Number.isSafeInteger(options.startupOwner) || options.startupOwner !== process.ppid)
        throw new Error('Startup owner must be the parent process')
    } else if (flag === '--audit-aliases') options.auditAliases = true
    else if (flag === '--retire-aliases') options.retireAliases = true
    else if (flag === '--execute') options.execute = true
    else if (flag === '--resume') options.resume = true
    else if (flag === '--rollback') options.rollback = true
    else if (flag === '--restart-after-rollback') options.restartAfterRollback = true
    else if (flag === '--allow-multi-instance') options.allowMultiInstance = true
    else if (flag === '--recover-lock') options.recoverLock = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--map') {
      const pair = JSON.parse(argv[++i])
      if (!pair.from || !pair.to) throw new Error('--map requires JSON {from,to}')
      options.maps.push(pair)
    } else if (flag === '--help') {
      console.log(
        'Usage: node scripts/migrate-brand-paths.mjs [--mode dev|packaged] [--home PATH] [--app-data PATH] [--config-root PATH] [--user-data PATH] [--map JSON] [--execute|--resume|--rollback] [--recover-lock] [--restart-after-rollback] [--audit-aliases|--retire-aliases] [--state-dir PATH] [--data-parent PATH]\nWithout an action this command only prints a dry-run plan. Stop all app and runtime processes before execution.'
      )
      return
    } else throw new Error(`Unknown argument: ${flag}`)
  }
  if (
    [
      options.execute,
      options.resume,
      options.rollback,
      options.auditAliases,
      options.retireAliases
    ].filter(Boolean).length > 1
  )
    throw new Error('Choose one migration action')
  if (
    options.dryRun &&
    (options.execute || options.resume || options.rollback || options.retireAliases)
  )
    throw new Error('--dry-run cannot be combined with a write action')
  if (options.restartAfterRollback && !options.execute)
    throw new Error('--restart-after-rollback requires --execute')
  if (process.platform === 'win32') {
    options.localAppData ??= process.env.LOCALAPPDATA
    options.tempParents ??= [process.env.TEMP, process.env.TMP].filter(Boolean)
  }
  options.appData ??=
    process.platform === 'darwin'
      ? join(options.home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA
        : (process.env.XDG_CONFIG_HOME ?? join(options.home, '.config'))
  const result = await runMigration(options)
  // Manifests stay in the private receipt; stdout is a concise operator-facing plan/result.
  const { journal, participants, ...summary } = result
  console.log(
    JSON.stringify(
      {
        ...summary,
        ...(journal ? { status: journal.status, mappings: journal.mappings } : {}),
        ...(participants ? { backups: participants.map((p) => p.backup) } : {})
      },
      null,
      2
    )
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Brand migration stopped: ${error.message}`)
    process.exitCode = 1
  })
}
