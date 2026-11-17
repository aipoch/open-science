import { useRef, useState } from 'react'
import { Bold, Italic, Underline, Link } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { PptxParagraph } from '../../../../../shared/pptx-edit'
import {
  selectedTextRuns,
  formatTextRange,
  paragraphsText,
  replaceText,
  type TextFormat
} from './pptx-text-format'

export const PptxRichTextEditor = ({
  label,
  initial,
  onApply,
  onCancel
}: {
  label: string
  initial: PptxParagraph[]
  onApply: (text: string, paragraphs: PptxParagraph[]) => void
  onCancel: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [paragraphs, setParagraphs] = useState(initial)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [linkOpen, setLinkOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [sizeDraft, setSizeDraft] = useState<string>()
  const input = useRef<HTMLTextAreaElement>(null)
  const text = paragraphsText(paragraphs)
  // With no text selected, controls apply to the entire text box.
  const start = selection.start === selection.end ? 0 : selection.start
  const end = selection.start === selection.end ? text.length : selection.end
  const selected = selectedTextRuns(paragraphs, start, end)
  const format = (patch: TextFormat): void => {
    setParagraphs((current) => formatTextRange(current, start, end, patch))
  }
  const validUrl = url === '' || /^(https?:\/\/|mailto:)\S+$/i.test(url)
  const validSizeDraft =
    sizeDraft === undefined ||
    (sizeDraft.trim() !== '' && Number(sizeDraft) >= 1 && Number(sizeDraft) <= 400)
  const controlClass =
    'h-8 rounded-md border border-border-300 bg-bg-000 px-2 text-xs text-text-000'
  return (
    <div className="absolute inset-x-4 bottom-4 z-30 flex max-h-[80%] flex-col gap-2 overflow-auto rounded-lg border border-border-300 bg-bg-000 p-3 shadow-lg">
      <div
        role="toolbar"
        aria-label={t('Text formatting')}
        className="flex flex-wrap items-center gap-1"
      >
        <input
          type="number"
          aria-label={t('Font size')}
          title={t('Font size')}
          min={1}
          max={400}
          step={0.5}
          className={`${controlClass} w-16`}
          placeholder="—"
          value={
            sizeDraft ??
            (selected.length && selected.every((r) => r.sizePt === selected[0]?.sizePt)
              ? (selected[0]?.sizePt ?? '')
              : '')
          }
          aria-invalid={!validSizeDraft}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => {
            if (validSizeDraft) setSizeDraft(undefined)
          }}
          onChange={(event) => {
            setSizeDraft(event.target.value)
            const sizePt = Number(event.target.value)
            if (sizePt >= 1 && sizePt <= 400) format({ sizePt })
          }}
        />
        {(
          [
            ['bold', t('Bold'), Bold],
            ['italic', t('Italic'), Italic],
            ['underline', t('Underline'), Underline]
          ] as const
        ).map(([key, title, Icon]) => (
          <Button
            key={key}
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={title}
            title={title}
            aria-pressed={selected.length > 0 && selected.every((r) => r[key])}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format({ [key]: !selected.every((r) => r[key]) })}
          >
            <Icon className="size-4" />
          </Button>
        ))}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t('Link')}
          title={t('Link')}
          aria-expanded={linkOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setUrl(selected[0]?.hyperlink ?? '')
            setLinkOpen(!linkOpen)
          }}
        >
          <Link className="size-4" />
        </Button>
        <input
          type="color"
          aria-label={t('Text color')}
          title={t('Text color')}
          className="size-8 cursor-pointer rounded border border-border-300 bg-bg-000 p-1"
          value={`#${selected[0]?.color ?? '000000'}`}
          onChange={(event) => format({ color: event.target.value.slice(1) })}
        />
      </div>
      {linkOpen ? (
        <div className="flex items-center gap-2">
          <input
            type="url"
            aria-label={t('Link')}
            aria-invalid={!validUrl}
            placeholder="https://"
            className={`${controlClass} min-w-0 flex-1`}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={!validUrl}
            onClick={() => {
              format({ hyperlink: url })
              setLinkOpen(false)
            }}
          >
            {t('Apply')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              format({ hyperlink: '' })
              setLinkOpen(false)
            }}
          >
            {t('Remove link')}
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-text-300">
        {t('Select text to format it, or format the entire text box.')}
      </p>
      <textarea
        ref={input}
        autoFocus
        aria-label={label}
        className="min-h-20 resize-none rounded-md border border-border-300 bg-bg-000 p-2 text-sm text-text-000 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={text}
        onChange={(event) => setParagraphs(replaceText(paragraphs, event.target.value))}
        onSelect={(event) =>
          setSelection({
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd
          })
        }
      />
      <div
        aria-label={t('Preview')}
        className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border-300 p-2"
      >
        {paragraphs.map((p, i) => (
          <div key={i} style={{ minHeight: '1em' }}>
            {p.runs.map((r, j) => (
              <span
                key={j}
                title={r.hyperlink || undefined}
                style={{
                  fontFamily: r.fontFamily,
                  fontSize: r.sizePt ? `${r.sizePt}pt` : undefined,
                  fontWeight: r.bold ? 'bold' : undefined,
                  fontStyle: r.italic ? 'italic' : undefined,
                  textDecoration: r.underline ? 'underline' : undefined,
                  color: r.color ? `#${r.color}` : undefined
                }}
              >
                {r.text}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!validSizeDraft}
          onClick={() => onApply(text, paragraphs)}
        >
          {t('Apply')}
        </Button>
      </div>
    </div>
  )
}
