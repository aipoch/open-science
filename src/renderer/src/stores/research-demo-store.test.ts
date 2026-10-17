// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import {
  isResearchDemoCarrier,
  refreshResearchDemoCarriers,
  useResearchDemoStore
} from './research-demo-store'

const carriers = vi.fn()
const source = { projectId: 'project', sourceSessionId: 'source', sourceImportId: 'import' }
beforeEach(() => {
  carriers.mockReset()
  useResearchDemoStore.setState({ carriersByProject: {} })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { researchDemos: { carriers } }
  })
})
it('groups only exact Main-owned carrier identities and ignores foreign project rows', async () => {
  carriers.mockResolvedValue([
    { sessionId: 'carrier', source },
    { sessionId: 'foreign', source: { ...source, projectId: 'other' } }
  ])
  await refreshResearchDemoCarriers('project')
  expect(isResearchDemoCarrier('project', 'carrier')).toBe(true)
  expect(isResearchDemoCarrier('project', 'old-discussion-86')).toBe(false)
  expect(isResearchDemoCarrier('project', 'foreign')).toBe(false)
  expect(isResearchDemoCarrier('other', 'carrier')).toBe(false)
})
it('keeps sessions visible when the owner index cannot be read', async () => {
  useResearchDemoStore.setState({
    carriersByProject: { project: [{ sessionId: 'carrier', source }] }
  })
  carriers.mockRejectedValue(new Error('Unavailable'))
  await refreshResearchDemoCarriers('project')
  expect(isResearchDemoCarrier('project', 'carrier')).toBe(false)
})
