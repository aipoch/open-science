// Diagnostic for the immutable installed archive. Record method and shape only.
const { syncBuiltinESMExports } = require('node:module')
const childProcess = require('node:child_process')
const original = childProcess.spawnSync
childProcess.spawnSync = function (command, args, options) {
  const result = original.apply(this, arguments)
  if (command === '/usr/bin/busctl' && args.includes('org.freedesktop.secrets')) {
    const method = args[args.indexOf('call') + 4]
    let shape = 'invalid-json'
    try {
      const value = JSON.parse(result.stdout)
      if (method === 'SearchItems') {
        shape = [value.type, value.data.map(items => items.length)]
      } else if (method === 'ReadAlias') {
        shape = [value.type, value.data.length, value.data[0] !== '/']
      } else {
        shape = [value.type, value.data.length, value.data[0]?.type, value.data[0]?.data === true]
      }
    } catch {}
    console.error('[probe]', JSON.stringify({ method, status: result.status, signal: result.signal, code: result.error?.code, shape }))
  }
  return result
}
syncBuiltinESMExports()
