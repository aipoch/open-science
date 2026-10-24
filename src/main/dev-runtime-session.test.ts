import { expect, it } from 'vitest'
import { readDevSession } from './dev-runtime-session'

it('ignores inherited dev supervision metadata when the host build has not enabled it', () => {
  expect(readDevSession(false, '{invalid inherited metadata')).toBeUndefined()
  expect(() => readDevSession(true, '{invalid inherited metadata')).toThrow()
  expect(readDevSession(true, undefined)).toBeUndefined()
})
