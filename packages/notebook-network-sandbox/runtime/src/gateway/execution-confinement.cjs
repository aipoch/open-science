'use strict'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Public types live in the adjacent .d.cts; this entry must execute as plain CommonJS. */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- This public entry supports CommonJS recovery subprocesses.
const { isIP } = require('node:net')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- This public entry supports CommonJS recovery subprocesses.
const { domainToASCII } = require('node:url')

// Pure policy validation shared by the ESM runtime and ordinary CommonJS recovery processes.
// This entry point deliberately does not load or initialize a native sandbox owner.
const normalizeHost = (value) => {
  if (typeof value !== 'string') throw new Error('Invalid execution network host.')
  const input = value.trim().toLowerCase().replace(/\.$/, '')
  if (isIP(input)) return input
  const ascii = domainToASCII(input)
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error('Execution network hosts must be exact hostnames, without ports or wildcards.')
  return ascii
}

const normalizeExecutionConfinement = (input) => {
  if (!input || !['offline-demo', 'research'].includes(input.mode))
    throw new Error('Invalid execution confinement mode.')
  if (input.allowedNetworkHosts !== undefined && !Array.isArray(input.allowedNetworkHosts))
    throw new Error('Invalid execution network hosts.')
  const hosts = [...new Set((input.allowedNetworkHosts ?? []).map(normalizeHost))].sort()
  if (input.mode === 'offline-demo' && hosts.length)
    throw new Error('Offline demonstrations cannot allow external network hosts.')
  return Object.freeze({ mode: input.mode, allowedNetworkHosts: Object.freeze(hosts) })
}

const executionConfinementAllowsHost = (confinement, host) => {
  if (confinement.mode === 'offline-demo') return false
  try {
    return confinement.allowedNetworkHosts?.includes(normalizeHost(host)) === true
  } catch {
    return false
  }
}

exports.normalizeExecutionConfinement = normalizeExecutionConfinement
exports.executionConfinementAllowsHost = executionConfinementAllowsHost
