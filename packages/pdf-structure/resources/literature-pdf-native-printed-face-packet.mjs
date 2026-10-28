/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { isDeepStrictEqual as equal } from 'node:util'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const outside = (a, b) => a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]

// Handles are aliases only in typed image-paint/dependency slots. Literal text,
// dimensions and every other operand remain exact across the two PDF tasks.
export function samePrintedFaceOperators(native, work, fonts) {
  if (
    !equal(Object.keys(native), ['fnArray', 'argsArray']) ||
    Object.keys(work).some(
      (k) => !['fnArray', 'argsArray', 'lastChunk', 'separateAnnots'].includes(k)
    ) ||
    (work.lastChunk !== undefined && work.lastChunk !== true) ||
    (work.separateAnnots !== undefined &&
      work.separateAnnots !== null &&
      !equal(work.separateAnnots, { form: false, canvas: false }))
  )
    return false
  const images = (root) => {
      const result = new Set(),
        active = new Set()
      let count = 0
      const visit = (o, depth) => {
        if (
          !o ||
          active.has(o) ||
          depth > 8 ||
          !Array.isArray(o.fnArray) ||
          o.fnArray.length !== o.argsArray?.length
        )
          return false
        active.add(o)
        for (const [i, op] of o.fnArray.entries()) {
          if (++count > 100000) return false
          const a = o.argsArray[i]
          if (op === OPS.paintImageXObject) {
            if (
              !Array.isArray(a) ||
              a.length !== 3 ||
              typeof a[0] !== 'string' ||
              !a[0] ||
              !a.slice(1).every((x) => Number.isSafeInteger(x) && x > 0)
            )
              return false
            result.add(a[0])
          } else if (
            [OPS.setFillColorN, OPS.setStrokeColorN].includes(op) &&
            a?.[0] === 'TilingPattern'
          ) {
            if (!Array.isArray(a) || a.length !== 9 || !visit(a[2], depth + 1)) return false
          }
        }
        active.delete(o)
        return true
      }
      return visit(root, 0) ? result : undefined
    },
    left = images(native),
    right = images(work),
    forward = new Map(),
    reverse = new Map()
  if (
    !left ||
    !right ||
    [...left].some((id) => fonts.has(id)) ||
    [...right].some((id) => new Set(fonts.values()).has(id))
  )
    return false
  const image = (a, b) => {
      if (
        !left.has(a) ||
        !right.has(b) ||
        (forward.has(a) && forward.get(a) !== b) ||
        (reverse.has(b) && reverse.get(b) !== a)
      )
        return false
      forward.set(a, b)
      reverse.set(b, a)
      return true
    },
    compare = (a, b) => {
      if (!equal(a.fnArray, b.fnArray) || !equal(Object.keys(a), Object.keys(b))) return false
      for (const key of Object.keys(a))
        if (!['fnArray', 'argsArray'].includes(key) && !equal(a[key], b[key])) return false
      for (const [i, op] of a.fnArray.entries()) {
        const x = a.argsArray[i],
          y = b.argsArray[i]
        if (op === OPS.paintImageXObject) {
          if (!image(x[0], y[0]) || !equal(x.slice(1), y.slice(1))) return false
        } else if (op === OPS.dependency) {
          if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false
          for (let j = 0; j < x.length; j++) {
            if (fonts.has(x[j])) {
              if (fonts.get(x[j]) !== y[j]) return false
            } else if (left.has(x[j])) {
              if (!image(x[j], y[j])) return false
            } else if (!equal(x[j], y[j])) return false
          }
        } else if (op === OPS.setFont && fonts.has(x?.[0])) {
          if (!Array.isArray(y) || fonts.get(x[0]) !== y[0] || !equal(x.slice(1), y.slice(1)))
            return false
        } else if (
          [OPS.setFillColorN, OPS.setStrokeColorN].includes(op) &&
          x?.[0] === 'TilingPattern'
        ) {
          if (
            !Array.isArray(y) ||
            y.length !== 9 ||
            !equal(x.slice(0, 2), y.slice(0, 2)) ||
            !equal(x.slice(3), y.slice(3)) ||
            !compare(x[2], y[2])
          )
            return false
        } else if (!equal(x, y)) return false
      }
      return true
    }
  return (
    compare(native, { fnArray: work.fnArray, argsArray: work.argsArray }) &&
    forward.size === left.size &&
    reverse.size === right.size
  )
}

// These entries have the same explicit semantics as their individual PDF.js
// operators. They are admitted only by the printed-face negative certificate.
export function printedFaceStateEntry(e) {
  return (
    Array.isArray(e) &&
    e.length === 2 &&
    ((e[0] === 'BM' && e[1] === 'source-over') ||
      (['LC', 'LJ'].includes(e[0]) && [0, 1, 2].includes(e[1])) ||
      (e[0] === 'LW' && Number.isFinite(e[1]) && e[1] > 0) ||
      (e[0] === 'ML' && Number.isFinite(e[1]) && e[1] >= 1))
  )
}

// A pattern's contents need not become ordinary opaque paint. Its entire
// stroke/fill domain and independently recorded paint bounds must be outside
// the protected table crop. No pattern-active text or optional-content state
// participates in this contract.
export function closedPrintedFaceProfile(page, context, evidence, scope) {
  const o = context?.operators,
    v = context?.viewport
  if (
    !valid(scope) ||
    scope[0] < 0 ||
    scope[1] < 0 ||
    scope[2] > page.width ||
    scope[3] > page.height ||
    context.pageNumber !== page.pageNumber ||
    !/^[a-f\d]{64}$/u.test(context.sourceSha256) ||
    !Array.isArray(context.graphicsBounds) ||
    !finite(v?.transform, 6)
  )
    return
  const neutral = new Set(),
    marks = [],
    stack = []
  let fill = false,
    stroke = false,
    miter = 10
  for (const [i, op] of o.fnArray.entries()) {
    const a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ fill, stroke, miter })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({ fill, stroke, miter } = stack.pop())
    } else if (op === OPS.beginMarkedContentProps) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        a[0] !== 'Figure' ||
        !Number.isSafeInteger(a[1]) ||
        a[1] < 0 ||
        marks.length >= 32
      )
        return
      marks.push(i)
      neutral.add(i)
    } else if (op === OPS.endMarkedContent) {
      if (!marks.length || a != null) return
      marks.pop()
      neutral.add(i)
    } else if (op === OPS.setFillColorN || op === OPS.setStrokeColorN) {
      if (
        !Array.isArray(a) ||
        a[0] !== 'TilingPattern' ||
        !Array.isArray(a[2]?.fnArray) ||
        a[2].fnArray.length !== a[2].argsArray?.length ||
        a[2].fnArray.length > 4096
      )
        return
      if (op === OPS.setFillColorN) fill = true
      else stroke = true
      neutral.add(i)
    } else if (op === OPS.setFillRGBColor) fill = false
    else if (op === OPS.setStrokeRGBColor) stroke = false
    else if (op === OPS.setMiterLimit) miter = a?.[0]
    else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !printedFaceStateEntry(e) &&
            !(
              Array.isArray(e) &&
              e.length === 2 &&
              ((['CA', 'ca'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
                (e[0] === 'SMask' && e[1] === false))
            )
        )
      )
        return
      for (const [key, value] of a[0]) if (key === 'ML') miter = value
    } else if (op === OPS.showText && fill) return
    else if (op === OPS.constructPath && (fill || stroke)) {
      if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
      const q = evidence.paths.get(i),
        stroked = [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(a?.[0]),
        filled = ![OPS.stroke, OPS.closeStroke].includes(a?.[0])
      if (!(stroked && stroke) && !(filled && fill)) continue
      if (
        !q ||
        !valid(q.clip) ||
        !finite(q.transform, 6) ||
        !finite(a?.[2], 4) ||
        !Number.isFinite(miter) ||
        miter < 1 ||
        (stroked && !(Number.isFinite(q.lineWidth) && q.lineWidth > 0))
      )
        return
      const pad = stroked ? (q.lineWidth * miter) / 2 : 0,
        matrix = Util.transform(v.transform, q.transform),
        r = Array.from(a[2], (x, k) => x + (k < 2 ? -pad : pad)),
        points = [
          [r[0], r[1]],
          [r[2], r[1]],
          [r[2], r[3]],
          [r[0], r[3]]
        ]
      if (!finite(matrix, 6)) return
      for (const p of points) Util.applyTransform(p, matrix)
      const clipped = [
          Math.max(Math.min(...points.map((p) => p[0])), q.clip[0]),
          Math.max(Math.min(...points.map((p) => p[1])), q.clip[1]),
          Math.min(Math.max(...points.map((p) => p[0])), q.clip[2]),
          Math.min(Math.max(...points.map((p) => p[1])), q.clip[3])
        ],
        recorded = context.graphicsBounds.filter((g) => g.operationIndex === i)
      if (
        !finite(clipped, 4) ||
        (valid(clipped) && !outside(clipped, scope)) ||
        !recorded.length ||
        recorded.some((g) => {
          const b = g.normalizedRect?.map((x, k) => x * (k % 2 ? v.height : v.width))
          return g.kind !== 'path' || !valid(b) || !outside(b, scope)
        })
      )
        return
    }
  }
  if (marks.length || stack.length) return
  return { neutral, outside: (r) => valid(r) && outside(r, scope) }
}
