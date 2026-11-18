import {
  ArrowLeft,
  ArrowRight,
  Copy,
  FileX2,
  ImageUp,
  Plus,
  Redo2,
  StickyNote,
  Trash2,
  Type,
  Undo2
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-contract'
import type { OfficePreviewSlideView } from '../../../../../shared/office-preview'
import type { PptxOperation } from '../../../../../shared/pptx-edit'
import { PptxSelectionOverlay } from './PptxSelectionOverlay'
import { PptxShapeEditor, type PptxShapeEditorState } from './PptxShapeEditor'
import type { FrameChange } from './pptx-edit-geometry'
import { measureTextFrame } from './pptx-text-frame'
import { readPptxImageFile } from './pptx-image-file'
import { notesEditorFor, shapeEditorFor, textToParagraphs } from './pptx-shape-text-fields'
import type { PptxEditSession } from './use-pptx-edit-session'
import { OfficePreviewContent } from './renderers/OfficePreview'

type PptxEditSurfaceProps = {
  item: PreviewFileItem
  source: PreviewFileSource
  session: PptxEditSession
  saving: boolean
}

type ImageProblem = 'unsupported' | 'too-large' | 'unreadable'

const PptxEditSurface = ({
  item,
  source,
  session,
  saving
}: PptxEditSurfaceProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [slideIndex, setSlideIndex] = useState(0)
  const [slideView, setSlideView] = useState<OfficePreviewSlideView>()
  const [selectedShapeId, setSelectedShapeId] = useState<number>()
  const [editor, setEditor] = useState<{ id: number; state: PptxShapeEditorState }>()
  const [imageProblem, setImageProblem] = useState<ImageProblem>()
  // Held in state rather than a ref because the toolbar's click handlers are built during render.
  const [imageInput, setImageInput] = useState<HTMLInputElement | null>(null)
  const view = session.view
  if (!view) return null
  const outline = view.outline
  const slideCount = outline.slides.length
  const slide = outline.slides[Math.min(slideIndex, slideCount - 1)]
  const selectedShape = slide?.shapes.find((shape) => shape.shapeId === selectedShapeId)
  const busy = saving || session.phase !== 'ready'

  const handleSlideView = (next: OfficePreviewSlideView): void => {
    setSlideView(next)
    if (next.slideIndex !== slideIndex) setSelectedShapeId(undefined)
    setSlideIndex(next.slideIndex)
  }
  const apply = (operations: PptxOperation[]): Promise<boolean> => {
    setImageProblem(undefined)
    return session.addOperations(operations)
  }
  // The staged preview opens the slide the surface names, so a structural edit names its result
  // up front and falls back to the previous slide if the edit is rejected.
  const applyAndGoTo = (operation: PptxOperation, nextIndex: number): void => {
    const previous = slideIndex
    setSelectedShapeId(undefined)
    setSlideIndex(nextIndex)
    void apply([operation]).then((applied) => {
      if (!applied) setSlideIndex(previous)
    })
  }

  const changeFrame = (shapeId: number, change: FrameChange): void => {
    if (!slide) return
    void apply([{ op: 'setFrame', slideId: slide.slideId, shapeId, ...change }])
  }
  const addTextbox = (): void => {
    if (!slide) return
    const { cx, cy } = outline.slideSize
    const paragraphs = textToParagraphs(t('New text')).map((paragraph) => ({
      runs: paragraph.runs.map((run) => ({ ...run, sizePt: 18, fontFamily: 'Arial' }))
    }))
    const size = measureTextFrame(paragraphs, Math.round(cx * 0.75))
    void apply([
      {
        op: 'addTextbox',
        slideId: slide.slideId,
        x: Math.round(cx / 4),
        y: Math.round(cy / 4),
        ...size,
        paragraphs
      }
    ])
  }
  const deleteSelected = (): void => {
    if (!slide || selectedShapeId === undefined) return
    void apply([{ op: 'deleteShape', slideId: slide.slideId, shapeId: selectedShapeId }])
    setSelectedShapeId(undefined)
  }
  const moveSlide = (offset: -1 | 1): void => {
    if (!slide) return
    applyAndGoTo(
      { op: 'moveSlide', slideId: slide.slideId, toIndex: slideIndex + offset },
      slideIndex + offset
    )
  }
  const deleteSlide = (): void => {
    if (!slide || slideCount <= 1) return
    applyAndGoTo(
      { op: 'deleteSlide', slideId: slide.slideId },
      Math.min(slideIndex, slideCount - 2)
    )
  }
  // A fresh id remounts the editor so switching targets never keeps the previous draft text.
  const openEditor = (state: PptxShapeEditorState): void =>
    setEditor((current) => ({ id: (current?.id ?? 0) + 1, state }))
  const beginShapeEdit = (shapeId: number): void => {
    const shape = slide?.shapes.find((candidate) => candidate.shapeId === shapeId)
    const next = slide && shape ? shapeEditorFor(slide.slideId, shape, t) : undefined
    if (next) openEditor(next)
  }
  const applyEditor = (operations: PptxOperation[]): void => {
    setEditor(undefined)
    const fitted = operations.flatMap((operation): PptxOperation[] => {
      if (operation.op !== 'setText') return [operation]
      const shape = outline.slides
        .find((candidate) => candidate.slideId === operation.slideId)
        ?.shapes.find((candidate) => candidate.shapeId === operation.shapeId)
      if (!shape?.frame) return [operation]
      const size = measureTextFrame(
        operation.paragraphs,
        Math.max(91440, outline.slideSize.cx - shape.frame.x),
        shape.textInsets
      )
      return [{ ...operation, frame: { ...shape.frame, ...size } }]
    })
    if (fitted.length > 0) void apply(fitted)
  }
  const replaceImage = async (file: File | undefined): Promise<void> => {
    if (!slide || !file || selectedShape?.kind !== 'picture') return
    const shapeId = selectedShape.shapeId
    try {
      const image = await readPptxImageFile(file)
      if (image.kind !== 'ready') return setImageProblem(image.kind)
      await apply([
        {
          op: 'replaceImage',
          slideId: slide.slideId,
          shapeId,
          mime: image.mime,
          dataBase64: image.dataBase64
        }
      ])
    } catch {
      setImageProblem('unreadable')
    }
  }

  const tools = [
    { label: t('Add text box'), icon: Type, run: addTextbox, disabled: busy },
    {
      label: t('Add slide'),
      icon: Plus,
      run: () => applyAndGoTo({ op: 'addSlide', afterSlideId: slide?.slideId }, slideIndex + 1),
      disabled: busy
    },
    {
      label: t('Duplicate slide'),
      icon: Copy,
      run: () =>
        slide && applyAndGoTo({ op: 'duplicateSlide', slideId: slide.slideId }, slideIndex + 1),
      disabled: busy || !slide
    },
    {
      label: t('Move slide earlier'),
      icon: ArrowLeft,
      run: () => moveSlide(-1),
      disabled: busy || !slide || slideIndex === 0
    },
    {
      label: t('Move slide later'),
      icon: ArrowRight,
      run: () => moveSlide(1),
      disabled: busy || !slide || slideIndex >= slideCount - 1
    },
    { label: t('Delete slide'), icon: FileX2, run: deleteSlide, disabled: busy || slideCount <= 1 },
    {
      label: t('Edit speaker notes'),
      icon: StickyNote,
      run: () => slide && openEditor(notesEditorFor(slide, t)),
      disabled: busy || !slide
    },
    {
      label: t('Replace image'),
      icon: ImageUp,
      run: () => imageInput?.click(),
      disabled: busy || selectedShape?.kind !== 'picture'
    },
    {
      label: t('Delete selected shape'),
      icon: Trash2,
      run: deleteSelected,
      disabled: busy || selectedShapeId === undefined
    },
    {
      label: t('Undo'),
      icon: Undo2,
      run: () => void session.undo(),
      disabled: busy || !session.canUndo
    },
    {
      label: t('Redo'),
      icon: Redo2,
      run: () => void session.redo(),
      disabled: busy || !session.canRedo
    }
  ]
  const problem =
    imageProblem === 'unsupported'
      ? t('Choose a PNG, JPEG, or GIF image.')
      : imageProblem === 'too-large' || session.failure === 'too-large'
        ? t('That image is too large for this presentation.')
        : imageProblem === 'unreadable'
          ? t('That image could not be read.')
          : session.failed
            ? t('That change could not be applied.')
            : undefined

  return (
    <div className="flex size-full min-h-0 flex-col" data-testid="pptx-edit-surface">
      <div
        role="toolbar"
        aria-label={t('Presentation editing tools')}
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-300 px-2 py-1"
      >
        {tools.map(({ label, icon: Icon, run, disabled }) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={run}
          >
            <Icon aria-hidden="true" />
          </Button>
        ))}
        {problem ? (
          <span role="alert" className="ml-2 text-xs text-destructive">
            {problem}
          </span>
        ) : null}
        <input
          ref={setImageInput}
          type="file"
          accept="image/png,image/jpeg,image/gif"
          className="hidden"
          data-testid="pptx-image-input"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Clearing lets the same file be chosen again after a failed attempt.
            event.target.value = ''
            void replaceImage(file)
          }}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <OfficePreviewContent
          item={item}
          source={source}
          staged={{ key: view.stagedKey, slideIndex, onSlideView: handleSlideView }}
        />
        <PptxSelectionOverlay
          outline={outline}
          slideIndex={slideIndex}
          slideView={slideView}
          selectedShapeId={selectedShapeId}
          disabled={busy}
          onSelect={setSelectedShapeId}
          onFrameChange={changeFrame}
          onEditText={beginShapeEdit}
        />
        {editor ? (
          <PptxShapeEditor
            key={editor.id}
            editor={editor.state}
            onApply={applyEditor}
            onCancel={() => setEditor(undefined)}
          />
        ) : null}
      </div>
    </div>
  )
}

export { PptxEditSurface }
export type { PptxEditSurfaceProps }
