import { expect, it } from 'vitest'
import {
  destinationGrantAllows,
  normalizeNetworkDestinationGrants,
  type NetworkDestinationGrant
} from './network-destination-grants'
const grant: NetworkDestinationGrant = {
  id: 'grant',
  hostname: 'service.test',
  port: 443,
  approvedAddresses: ['10.0.0.1', '10.0.0.2'],
  scope: 'project',
  projectId: 'one',
  sessionId: 'session',
  recordId: 'record',
  createdAt: 1
}
it('matches a whole approved set within the exact destination and project', () => {
  expect(destinationGrantAllows(grant, 'one', 'service.test', 443, ['10.0.0.2'])).toBe(true)
  for (const [project, host, port, addresses] of [
    ['two', 'service.test', 443, ['10.0.0.1']],
    ['one', 'other.test', 443, ['10.0.0.1']],
    ['one', 'service.test', 80, ['10.0.0.1']],
    ['one', 'service.test', 443, ['10.0.0.1', '10.0.0.3']],
    ['one', 'service.test', 443, []]
  ] as const)
    expect(destinationGrantAllows(grant, project, host, port, addresses)).toBe(false)
  expect(
    destinationGrantAllows({ ...grant, scope: 'global' }, 'two', 'service.test', 443, ['10.0.0.1'])
  ).toBe(true)
})
it('does not merge duplicate grant identities or retain unreviewed fields', () => {
  expect(normalizeNetworkDestinationGrants([grant, grant])).toEqual([])
  expect(normalizeNetworkDestinationGrants([{ ...grant, decision: 'approved' }])).toEqual([grant])
})
