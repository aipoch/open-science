/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */

const { readFileSync, writeFileSync } = require('node:fs')
const { basename } = require('node:path')

const command = basename(process.argv[1] ?? '')
if (!['exec-gql', 'service', 'status', 'version'].includes(command)) return

const statePath = process.env.OPEN_SCIENCE_FAKE_REMOTEIT_STATE
if (!statePath) throw new Error('OPEN_SCIENCE_FAKE_REMOTEIT_STATE is required.')

const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state))
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

if (command === 'version') {
  process.stdout.write('1.0.0\n')
  process.exit(0)
}

if (command === 'status') {
  output({
    code: 0,
    data: {
      owner: 'electron-e2e',
      device: { id: 'electron-e2e-device' },
      services: readState().services
    }
  })
  process.exit(0)
}

if (command === 'service') {
  const state = readState()
  const operation = process.argv[2]
  const name = option('--name')
  const id = option('--id') ?? (name === 'Open Science Remote' ? 'app-service' : 'browser-service')
  const existing = state.services.find((service) => service.id === id)
  const service = existing ?? { id }
  service.name = name ?? service.name
  service.addressHost = option('--hostname') ?? '127.0.0.1'
  service.addressPort = Number(option('--port'))
  service.type = 7
  service.isEnabled = option('--enable') !== 'false'
  service.state = service.isEnabled ? 4 : 0
  if (operation === 'add' && !existing) state.services.push(service)
  writeState(state)
  output({ code: 0, data: { id } })
  process.exit(0)
}

const query = option('--query') ?? ''
const serviceId = query.match(/serviceId:\s*"([^"]+)"/)?.[1]
const enabled = query.includes('enabled: true')
output({
  code: 0,
  data: {
    data: {
      setConnectLink: {
        enabled,
        ...(enabled ? { url: 'https://fixture.connect.remote.it/' } : {}),
        service: { id: serviceId }
      }
    }
  }
})
process.exit(0)
