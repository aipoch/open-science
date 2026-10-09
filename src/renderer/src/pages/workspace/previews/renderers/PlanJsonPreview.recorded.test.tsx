// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArtifactVersionLocator } from '../../../../../../shared/artifact-provenance'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../../../shared/web-caller-location'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { PlanJsonPreview } from './PlanJsonPreview'
const { state, observed } = vi.hoisted(() => ({
  state: {
    status: 'ready',
    preview: {
      content: '{"format":"open-science-run-observation","version":1}',
      encoding: 'utf8',
      truncated: false
    },
    pagination: { pageNumber: 1 }
  },
  observed: vi.fn()
}))
vi.mock('../usePreviewFileContent', () => ({ usePreviewFileContent: () => state }))
vi.mock('./JsonPreview', () => ({ JsonPreviewBody: () => <div data-testid="raw-json" /> }))
vi.mock('../../RunObservationPreview', () => ({
  RunObservationPreview: (props: unknown) => {
    observed(props)
    return <div data-testid="recorded-frame" />
  }
}))
const item = (versionId = 'version'): PreviewFileItem => ({
  id: 'preview',
  type: 'file',
  source: 'artifact',
  projectId: 'project',
  sessionId: 'current',
  title: 'renamed.json',
  name: 'renamed.json',
  format: 'json',
  artifactId: 'artifact',
  selectedVersionId: versionId,
  path: createArtifactVersionLocator({
    projectId: 'project',
    appSessionId: 'owner-session',
    artifactId: 'artifact',
    versionId
  })
})
beforeEach(() => {
  state.preview.content = '{"format":"open-science-run-observation","version":1}'
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { observations: { openRecorded: vi.fn() } }
  })
  observed.mockClear()
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
})
describe('recorded JSON preview entry', () => {
  it('requires an explicit click, shows the receiving immutable Version in place, and returns to raw JSON', async () => {
    render(<PlanJsonPreview item={item()} readOnly />)
    expect(screen.getByTestId('raw-json')).toBeTruthy()
    expect(observed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'View archived replay' }))
    await screen.findByTestId('recorded-frame')
    expect(observed.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'recorded',
      target: {
        projectId: 'project',
        sessionId: 'owner-session',
        artifactId: 'artifact',
        versionId: 'version'
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }))
    expect(screen.queryByTestId('recorded-frame')).toBeNull()
    expect(screen.getByTestId('raw-json')).toBeTruthy()
  })
  it('resets the viewing state when a file dialog changes Version', async () => {
    const view = render(<PlanJsonPreview item={item()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View archived replay' }))
    await screen.findByTestId('recorded-frame')
    view.rerender(<PlanJsonPreview item={item('new-version')} />)
    expect(screen.queryByTestId('recorded-frame')).toBeNull()
    expect(screen.getByRole('button', { name: 'View archived replay' })).toBeTruthy()
  })
  it('does not change ordinary JSON or expose a native viewer in the remote web workspace', () => {
    state.preview.content = '{"normal":"data"}'
    const view = render(<PlanJsonPreview item={item()} />)
    expect(screen.queryByRole('button')).toBeNull()
    state.preview.content = '{"format":"open-science-run-observation","version":1}'
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'remote')
    view.rerender(<PlanJsonPreview item={item()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
