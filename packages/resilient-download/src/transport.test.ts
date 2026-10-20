import { it } from 'vitest'
import * as api from './index'
import { verifyTransport } from '../test/transport.mjs'

it.each(['complete', 'resume', 'checksum', 'cancel', 'origin', 'stall'])(
  'honors the public download contract with real HTTP and files: %s',
  async (scenario) => verifyTransport(api, scenario)
)
