import type { DeckOutline, ShapeOutline, SlideOutline } from './outline'

export type PptxSlideChange =
  'text' | 'notes' | 'layout' | 'geometry' | 'image' | 'table' | 'chart' | 'shapes'

export type PptxSlideDiff =
  | { kind: 'added'; slideId: number; toIndex: number }
  | { kind: 'removed'; slideId: number; fromIndex: number }
  | {
      kind: 'changed'
      slideId: number
      fromIndex: number
      toIndex: number
      moved: boolean
      changes: PptxSlideChange[]
    }

export type PptxOutlineDiff = {
  slideSizeChanged: boolean
  // Slides of the target in order, then removed slides in their original order.
  slides: PptxSlideDiff[]
}

const CHANGE_ORDER: readonly PptxSlideChange[] = [
  'shapes',
  'text',
  'table',
  'chart',
  'image',
  'geometry',
  'layout',
  'notes'
]

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const sameFrame = (left: ShapeOutline['frame'], right: ShapeOutline['frame']): boolean =>
  sameJson(left, right)

// Replacing an image always writes a new media part; the size catches decks rebuilt elsewhere.
const sameImage = (left: ShapeOutline, right: ShapeOutline): boolean =>
  left.mediaPart === right.mediaPart && left.mediaBytes === right.mediaBytes

const compareShapes = (
  base: readonly ShapeOutline[],
  target: readonly ShapeOutline[],
  changes: Set<PptxSlideChange>
): void => {
  const byId = new Map(base.map((shape) => [shape.shapeId, shape]))
  const order = (shapes: readonly ShapeOutline[]): string =>
    shapes.map((shape) => shape.shapeId).join(',')
  // Added, removed and restacked shapes all change what is drawn on top of what.
  if (order(base) !== order(target)) changes.add('shapes')
  for (const shape of target) {
    const before = byId.get(shape.shapeId)
    if (!before) continue
    if (before.kind !== shape.kind) {
      changes.add('shapes')
      continue
    }
    if (before.text !== shape.text || !sameJson(before.paragraphs, shape.paragraphs))
      changes.add('text')
    if (!sameFrame(before.frame, shape.frame)) changes.add('geometry')
    if (shape.kind === 'picture' && !sameImage(before, shape)) changes.add('image')
    if (!sameJson(before.table, shape.table)) changes.add('table')
    if (!sameJson(before.chart, shape.chart)) changes.add('chart')
    if (before.children || shape.children) {
      compareShapes(before.children ?? [], shape.children ?? [], changes)
    }
  }
}

const slideChanges = (base: SlideOutline, target: SlideOutline): PptxSlideChange[] => {
  const changes = new Set<PptxSlideChange>()
  compareShapes(base.shapes, target.shapes, changes)
  if (base.layoutPart !== target.layoutPart) changes.add('layout')
  if (base.notes !== target.notes) changes.add('notes')
  return CHANGE_ORDER.filter((change) => changes.has(change))
}

// Slides outside the longest common subsequence of kept slides are the ones that moved.
const stableSlideIds = (base: readonly number[], target: readonly number[]): Set<number> => {
  const lengths = Array.from({ length: base.length + 1 }, () =>
    new Array<number>(target.length + 1).fill(0)
  )
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = target.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        base[i] === target[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }
  const stable = new Set<number>()
  let i = 0
  let j = 0
  while (i < base.length && j < target.length) {
    if (base[i] === target[j]) {
      stable.add(base[i])
      i += 1
      j += 1
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i += 1
    else j += 1
  }
  return stable
}

export const diffPptxOutlines = (base: DeckOutline, target: DeckOutline): PptxOutlineDiff => {
  const baseById = new Map(base.slides.map((slide, index) => [slide.slideId, { slide, index }]))
  const targetIds = new Set(target.slides.map((slide) => slide.slideId))
  const kept = (slides: readonly SlideOutline[]): number[] =>
    slides.map((slide) => slide.slideId).filter((id) => baseById.has(id) && targetIds.has(id))
  const stable = stableSlideIds(kept(base.slides), kept(target.slides))
  const slides: PptxSlideDiff[] = []
  target.slides.forEach((slide, toIndex) => {
    const before = baseById.get(slide.slideId)
    if (!before) {
      slides.push({ kind: 'added', slideId: slide.slideId, toIndex })
      return
    }
    const changes = slideChanges(before.slide, slide)
    const moved = !stable.has(slide.slideId)
    if (!moved && changes.length === 0) return
    slides.push({
      kind: 'changed',
      slideId: slide.slideId,
      fromIndex: before.index,
      toIndex,
      moved,
      changes
    })
  })
  base.slides.forEach((slide, fromIndex) => {
    if (!targetIds.has(slide.slideId))
      slides.push({ kind: 'removed', slideId: slide.slideId, fromIndex })
  })
  return { slideSizeChanged: !sameJson(base.slideSize, target.slideSize), slides }
}
