import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from './paths.mjs'
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
    } else if (flag === '--recover-incomplete-lock') {
      const fingerprint = argv[++i]
      if (!/^[a-f0-9]{64}$/.test(fingerprint ?? ''))
        throw new Error('Expected an inspected lock SHA-256 fingerprint')
      ;(options.recoverIncompleteLock ??= []).push(fingerprint)
    } else if (flag === '--show-progress-window') options.showProgressWindow = true
    else if (flag === '--audit-aliases') options.auditAliases = true
    else if (flag === '--retire-aliases') options.retireAliases = true
    else if (flag === '--execute') options.execute = true
    else if (flag === '--fresh-dev-migration') options.freshDevMigration = true
    else if (flag === '--restart-preparing') options.restartPreparing = true
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
        'Usage: node scripts/migrate-brand-paths.mjs [--mode dev|packaged] [--home PATH] [--app-data PATH] [--config-root PATH] [--user-data PATH] [--map JSON] [--execute|--resume|--rollback|--restart-preparing] [--fresh-dev-migration] [--recover-lock] [--recover-incomplete-lock SHA256] [--restart-after-rollback] [--audit-aliases|--retire-aliases] [--state-dir PATH] [--data-parent PATH]\nWithout an action this command only prints a dry-run plan. Stop all app and runtime processes before execution.'
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
      options.retireAliases,
      options.restartPreparing
    ].filter(Boolean).length > 1
  )
    throw new Error('Choose one migration action')
  if (
    options.dryRun &&
    (options.execute ||
      options.resume ||
      options.rollback ||
      options.retireAliases ||
      options.restartPreparing)
  )
    throw new Error('--dry-run cannot be combined with a write action')
  if (options.recoverIncompleteLock && !options.recoverLock)
    throw new Error('--recover-incomplete-lock requires --recover-lock')
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
  if (options.showProgressWindow && !options.startupOwner)
    throw new Error('The progress window requires an application startup owner')
  const ui = options.showProgressWindow
    ? await (
        await import('./startup-progress.mjs')
      ).openProgressWindow(
        (
          await readJson(
            join(
              options.configRoot ??
                join(
                  options.home,
                  options.mode === 'dev' ? '.open-science-project' : '.open-science'
                ),
              'settings.json'
            )
          ).catch(() => undefined)
        )?.localePreference
      )
    : undefined
  // Ignore only our known UI processes in the executable scan; the open-file guard still checks
  // every helper descriptor. The isolated UI must never hold a migration root.
  if (ui) options.ignorePids = ui.pids
  let last = { phase: 'checking' }
  const startedAt = Date.now()
  const logProgress = (event) => {
    last = event
    process.stderr.write(
      `[brand-migration] ${JSON.stringify({ ...event, elapsedMs: Date.now() - startedAt })}\n`
    )
    ui?.update(event)
  }
  const heartbeat = setInterval(() => {
    process.stderr.write(
      `[brand-migration] ${JSON.stringify({ ...last, heartbeat: true, elapsedMs: Date.now() - startedAt })}\n`
    )
  }, 10000)
  heartbeat.unref()
  let result
  try {
    result = await runMigration(options, { onProgress: logProgress })
    await ui?.complete()
  } catch (error) {
    // The failure window can stay open indefinitely; its lifetime is not active migration work.
    clearInterval(heartbeat)
    process.stderr.write(`Brand migration stopped: ${error.message}\n`)
    await ui?.fail(error)
    throw error
  } finally {
    clearInterval(heartbeat)
  }
  // Manifests stay in the private receipt; stdout is a concise operator-facing plan/result.
  const { journal, participants, restart, ...summary } = result
  const existingTargetBackups = (participants ?? journal?.participants ?? []).flatMap((p) =>
    p.previousTarget
      ? [{ from: p.to, backup: p.previousTarget.backup, kind: p.previousTarget.kind }]
      : []
  )
  console.log(
    JSON.stringify(
      {
        ...summary,
        ...(restart ? { restartPending: true } : {}),
        ...(journal ? { status: journal.status, mappings: journal.mappings } : {}),
        ...(participants ? { backups: participants.map((p) => p.backup) } : {}),
        ...(existingTargetBackups.length ? { existingTargetBackups } : {})
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
