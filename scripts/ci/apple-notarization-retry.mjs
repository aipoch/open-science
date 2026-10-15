/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

// CFNetwork logs can contain headers and bodies. Export only protocol and numeric timing fields.
export const summarizeAppleNetworkLog = (text) => {
  const summaries = []
  for (const line of text.split('\n')) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry.processImagePath?.endsWith('/stapler')) continue
    const message = entry.eventMessage ?? ''
    const metrics = {}
    for (const key of [
      'transaction_duration_ms',
      'request_duration_ms',
      'response_duration_ms',
      'response_status',
      'connection',
      'reused',
      'request_bytes',
      'response_bytes'
    ]) {
      const value = message.match(new RegExp(`\\b${key}=(-?\\d+(?:\\.\\d+)?)(?=[, }])`))?.[1]
      if (value !== undefined) metrics[key] = Number(value)
    }
    const protocol = message.match(
      /\bprotocol="?(h[123]|http\/?[123](?:\.\d)?|quic|tcp)"?(?=[, }])/i
    )?.[1]
    if (protocol) metrics.protocol = protocol
    if (Object.keys(metrics).length) summaries.push({ pid: entry.processID, ...metrics })
  }
  return summaries
}

// Error 68 also covers permanent ticket/signature failures. Retry only explicit transport evidence.
// https://developer.apple.com/library/archive/qa/qa1941/_index.html
export const isRetryableAppleFailure = (output) => {
  const codes = [...output.matchAll(/(?:Error Domain=)?NSURLErrorDomain\s+Code=(-?\d+)\b/g)]
  return (
    codes.length > 0 &&
    codes.every((match) => match[1] === '-1005') &&
    !/"status"\s*:\s*"(?:Invalid|Rejected)"|HTTP(?: status(?: code)?)?[:\s]+(?:401|403)|invalid credentials|unauthorized|revoked|invalid signature|ticket.*(?:invalid|not found)/i.test(
      output
    )
  )
}

const execute = (args, timeout) =>
  new Promise((resolveCommand) => {
    execFile(
      'xcrun',
      args,
      { timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolveCommand({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr: `${stderr}${error && !stderr ? `\nCommand failed (${error.code ?? error.signal ?? 'unknown'}).` : ''}`,
          interrupted: Boolean(error?.killed || error?.signal)
        })
    )
  })

export const runAppleCommand = async (
  args,
  {
    run = execute,
    delay = sleep,
    now = Date.now,
    log = (message) => process.stderr.write(`${message}\n`)
  } = {}
) => {
  const [tool, operation] = args
  const retryableOperation =
    (tool === 'stapler' && ['staple', 'validate'].includes(operation)) ||
    (tool === 'notarytool' && ['wait', 'info', 'log'].includes(operation))
  if (!retryableOperation)
    throw new Error(`Unsupported Apple retry operation: ${tool} ${operation}`)
  // Wait retries share one 15-minute deadline; a retry must not reset Apple's processing budget.
  const wait = tool === 'notarytool' && operation === 'wait'
  const budgetMs = wait ? 15 * 60_000 : 3 * 60_000
  const deadline = now() + budgetMs
  const backoff = [10_000, 30_000]
  let result
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    const remaining = deadline - now()
    if (remaining <= 0) break
    const commandArgs = [...args]
    if (wait) {
      const index = commandArgs.indexOf('--timeout')
      if (index !== -1) commandArgs.splice(index, 2)
      commandArgs.push('--timeout', `${Math.max(1, Math.floor(remaining / 1000))}s`)
    }
    log(`Apple ${tool} ${operation}: attempt ${attempt + 1}/${backoff.length + 1}`)
    result = await run(commandArgs, Math.min(remaining, wait ? budgetMs : 60_000))
    // Preserve every attempt, including the error domain and failing endpoint. Never print argv:
    // notarytool credentials are arguments. Final stdout remains machine-readable JSON for callers.
    log(result.stdout)
    log(result.stderr)
    if (result.code === 0) return result
    if (result.interrupted || !isRetryableAppleFailure(`${result.stdout}\n${result.stderr}`)) break
    const pause = backoff[attempt]
    if (pause === undefined || now() + pause >= deadline) break
    log(`Transient Apple connection loss; retrying only ${operation} in ${pause / 1000}s.`)
    await delay(pause)
  }
  return result ?? { code: 1, stdout: '', stderr: 'Apple operation deadline exhausted.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--summarize-network') {
    const summaries = summarizeAppleNetworkLog(await readFile(process.argv[3], 'utf8'))
    console.log(JSON.stringify({ networkSummaries: summaries }, null, 2))
  } else
    runAppleCommand(process.argv.slice(2))
      .then((result) => {
        process.stdout.write(result.stdout)
        process.exitCode = result.code
      })
      .catch((error) => {
        console.error(error.message)
        process.exitCode = 1
      })
}
