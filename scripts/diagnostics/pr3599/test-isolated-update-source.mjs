import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startIsolatedUpdateSource } from './isolated-update-source.mjs'
import { createServer } from 'node:http'
const directory = process.argv[2]
const evidence = (name, value) => writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2))
const runProcess = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env: options.env, windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(async () => {
    await evidence('source-preflight-timeout', { pid: child.pid, stdout, stderr })
    child.kill()
    reject(new Error('Source preflight timed out; see update-source-setup.log'))
  }, options.timeoutMs)
  child.on('error', reject)
  child.on('close', code => { clearTimeout(timer); if (code === 0) resolve({ code, stdout, stderr }); else reject(new Error(stdout + stderr)) })
})
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('isolated-source-tls-route-confirmed') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let source
try {
  source = await startIsolatedUpdateSource({ runProcess, evidence, directory, getSource: () => 'http://127.0.0.1:' + server.address().port })
  const response = await runProcess('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "$ErrorActionPreference='Stop'; (Invoke-WebRequest -UseBasicParsing -Uri 'https://statics.aipoch.com/open-science/app/stable/latest.yml' -TimeoutSec 15).Content"], { env:process.env, timeoutMs:20000 })
  await evidence('source-preflight-https-response', response)
  if(response.stdout.trim() !== 'isolated-source-tls-route-confirmed') throw new Error('The ordinary account HTTPS request did not reach the isolated source')
} finally { if(source) await source.close(); await new Promise(resolve => server.close(resolve)) }
console.log('PASS: isolated account source setup, actual trusted HTTPS request and restoration')
