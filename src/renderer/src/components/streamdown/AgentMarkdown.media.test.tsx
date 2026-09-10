// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionMessageMarkdown } from '@/pages/workspace/SessionMessageMarkdown'
import { PresentedAgentMarkdown } from './AgentMarkdown'

afterEach(cleanup)
const url = 'https://unapproved.invalid/pixel.png?research=CANARY'
it('keeps a message image off the network until activation and resets consent when the URL changes', () => {
  const props = { artifacts: [], onPreviewArtifact: vi.fn(), onPreviewArtifactModal: vi.fn() }
  const view = render(<SessionMessageMarkdown {...props} content={`![Figure](${url})`} />)
  expect(view.container.querySelector('img[src]')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /unapproved.invalid/ }))
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(url)
  view.rerender(<SessionMessageMarkdown {...props} content={`![Figure](${url}&changed=1)`} />)
  expect(view.container.querySelector('img[src]')).toBeNull()
})
it.each([false, true])(
  'gates HTML image, video poster and nested sources in streaming=%s',
  (isAnimating) => {
    const content = `<img src="${url}" alt="Figure" />\n\n<video controls poster="https://poster.invalid/poster.png"><source src="https://video.invalid/movie.mp4" type="video/mp4" /><track src="https://captions.invalid/captions.vtt" /></video>`
    const view = render(<PresentedAgentMarkdown content={content} isAnimating={isAnimating} />)
    expect(view.container.querySelector('img[src],video[poster],source[src],track[src]')).toBeNull()
    const videoButton = view.getByRole('button', { name: /poster.invalid/ })
    expect(videoButton.textContent).toContain('video.invalid')
    expect(videoButton.textContent).toContain('captions.invalid')
    fireEvent.click(videoButton)
    expect(view.container.querySelector('video')?.getAttribute('poster')).toContain(
      'poster.invalid'
    )
    expect(view.container.querySelector('source')?.getAttribute('src')).toContain('video.invalid')
    expect(view.container.querySelector('img[src]')).toBeNull()
  }
)
it('preserves local SVG references and disabled-media previews', () => {
  const content = '<svg><use href="#chart" /></svg>\n\n![Figure](https://remote.invalid/a.png)'
  const view = render(<PresentedAgentMarkdown content={content} />)
  expect(view.container.querySelector('use')?.getAttribute('href')).toBe('#chart')
  view.rerender(<PresentedAgentMarkdown content={content} allowMedia={false} />)
  expect(view.container.querySelector('img')).toBeNull()
})
it('does not load SVG references or orphan sources from remote sites', () => {
  const view = render(
    <PresentedAgentMarkdown
      content={
        '<svg><use href="https://remote.invalid/a.svg#x" /></svg>\n\n<source src="https://remote.invalid/a.mp4" />'
      }
    />
  )
  expect(view.container.querySelector('[href^="https:"],[src^="https:"]')).toBeNull()
})
