// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Notice, type NoticeLevel } from './notice'
import { ErrorNotice } from './error-notice'
import { InlineNotice } from './ui/inline-notice'

afterEach(cleanup)

it.each<NoticeLevel>(['info', 'warning', 'error'])(
  'supports %s without making passive guidance a live alert',
  (level) => {
    render(
      <Notice
        level={level}
        role="note"
        content={
          <>
            <p>First reason</p>
            <p>Second reason</p>
          </>
        }
      />
    )
    const summary = screen.getByRole('note')
    expect(summary.textContent).toBe('First reasonSecond reason')
    expect(summary.closest('section')?.dataset.noticeLevel).toBe(level)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(summary.querySelector('p p')).toBeNull()
  }
)

it('keeps existing error and contextual callers on the same semantic renderer', () => {
  const { container } = render(
    <>
      <ErrorNotice tone="teal" title="Information" />
      <InlineNotice>Warning</InlineNotice>
      <ErrorNotice tone="red" title="Failure" />
    </>
  )
  expect(
    [...container.querySelectorAll('section')].map((node) => node.dataset.noticeLevel)
  ).toEqual(['info', 'warning', 'error'])
})
