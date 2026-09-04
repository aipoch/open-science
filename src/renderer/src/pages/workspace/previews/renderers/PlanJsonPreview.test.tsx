// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore } from '@/stores/session-store'

import { planTestDocument, planTestProjection } from '../../session-plan/plan-test-fixtures'

import { createManagedPreviewTestTransport } from '../managed-preview-test-support'
import { PlanJsonPreview } from './PlanJsonPreview'

const item = {
  id: 'file-plan',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'plan-version-1.json',
  type: 'file' as const,
  path: 'artifact://plan-version-1.json',
  name: 'plan-version-1.json',
  format: 'json' as const,
  managedFileId: 'file-plan',
  selectedVersionId: 'version-1'
}

const readPreview = vi.fn()

const mockFile = (content: string, options?: { truncated?: boolean }): void => {
  readPreview.mockResolvedValue({
    content,
    encoding: 'utf8',
    size: content.length,
    truncated: options?.truncated ?? false
  })
}

beforeEach(() => {
  readPreview.mockReset()
  const transport = createManagedPreviewTestTransport({
    read: (_source, request) => readPreview(request)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      previewResources: {
        acquire: vi.fn(transport.acquire),
        readRange: vi.fn(),
        release: vi.fn(transport.release)
      },
      artifacts: { readPreview }
    }
  })
  vi.stubGlobal('fetch', vi.fn(transport.fetch))
  useSessionStore.setState({ sessions: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Plan-aware JSON preview', () => {
  it('renders the Plan document view for a previewed Plan artifact', async () => {
    mockFile(JSON.stringify(planTestDocument, null, 2))
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          activePlanProjection: planTestProjection('version-1')
        } as never
      ]
    })

    render(<PlanJsonPreview item={item} />)

    const heading = await screen.findByRole('heading', { name: 'Analyze one dataset' })
    expect(heading.className).not.toContain('line-clamp-3')
    expect(screen.getAllByText('Analyze one dataset')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'View raw JSON' })).toBeTruthy()
    expect(screen.getByLabelText('Analyze the data status: completed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('renders the stale banner when the Session runs a newer plan', async () => {
    mockFile(JSON.stringify(planTestDocument, null, 2))
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          planHistoryProjections: [planTestProjection('version-1')],
          activePlanProjection: planTestProjection('version-2')
        } as never
      ]
    })

    render(<PlanJsonPreview item={item} />)

    expect(
      await screen.findByText(
        '⚠ This plan has been replaced by another plan and is no longer current.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Analyze one dataset' })).toBeTruthy()
  })

  it('keeps ordinary JSON files on the raw JSON view', async () => {
    mockFile(JSON.stringify({ name: 'results', rows: 3 }, null, 2))

    render(<PlanJsonPreview item={item} />)

    expect(await screen.findByText(/"results"/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'View raw JSON' })).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('falls back to a snapshot view when no stored projection matches', async () => {
    mockFile(JSON.stringify(planTestDocument, null, 2))

    render(<PlanJsonPreview item={item} />)

    expect(
      await screen.findByText(
        'This plan is shown as a saved snapshot. Step progress is unavailable for archived sessions.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Analyze one dataset' })).toBeTruthy()
    expect(screen.getByLabelText('Analyze the data status: not started')).toBeTruthy()
    expect(
      screen.queryByText('⚠ This plan has been replaced by another plan and is no longer current.')
    ).toBeNull()
  })

  it('toggles between the Plan view and the raw JSON view', async () => {
    mockFile(JSON.stringify(planTestDocument, null, 2))
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          activePlanProjection: planTestProjection('version-1')
        } as never
      ]
    })

    render(<PlanJsonPreview item={item} />)

    expect(await screen.findByRole('heading', { name: 'Analyze one dataset' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }))

    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText(/"schema_version"/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View plan' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'View plan' }))
    expect(screen.getByRole('heading', { name: 'Analyze one dataset' })).toBeTruthy()
  })

  it('keeps truncated Plan files on the raw JSON view', async () => {
    mockFile(JSON.stringify(planTestDocument, null, 2), { truncated: true })

    render(<PlanJsonPreview item={item} />)

    expect(await screen.findByText(/"schema_version"/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'View raw JSON' })).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
  })
})
