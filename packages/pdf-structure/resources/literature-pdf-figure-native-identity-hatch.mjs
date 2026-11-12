/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeRecoveryOwnValues } from './literature-pdf-native-figure-recovery-profile.mjs'

// A separate pixel purpose recognizes only the complete identity diagonal
// tile. Destination path and clip bounds, not a guessed hatch extent, bound
// every repeated tile's paint. The original descriptors remain retained.
export function nativeIdentityHatchPatternStates(o, sixPanels = false) {
  const states = new Map(),
    patterns = []
  for (let i = 0; i < o.fnArray.length; i++) {
    if (o.fnArray[i] === OPS.setGState) {
      const a = o.argsArray[i]?.[0]
      if (
        !Array.isArray(a) ||
        !a.length ||
        a.length > 2 ||
        a.some(
          (e) => !Array.isArray(e) || e.length !== 2 || !['CA', 'ca'].includes(e[0]) || e[1] !== 1
        ) ||
        new Set(a.map((e) => e[0])).size !== a.length
      )
        return
    }
    if (o.fnArray[i] !== OPS.setFillColorN) continue
    const a = o.argsArray[i],
      q = a?.[2],
      m = a?.[3],
      b = a?.[4],
      line = q?.argsArray?.[2],
      path = line?.[1]?.[0],
      width = q?.argsArray?.[1]?.[0]
    if (
      !Array.isArray(a) ||
      a.length !== 9 ||
      a[0] !== 'TilingPattern' ||
      !/^#[a-f0-9]{6}$/iu.test(a[1] ?? '') ||
      a[1].toLowerCase() === '#ffffff' ||
      !nativeRecoveryOwnValues(q) ||
      Reflect.ownKeys(q).sort().join(',') !== 'argsArray,fnArray,length' ||
      q.length !== 4 ||
      !Array.isArray(q.fnArray) ||
      !Array.isArray(q.argsArray) ||
      q.argsArray.length !== 4 ||
      q.fnArray.length !== 4 ||
      q.fnArray.some(
        (op, k) => op !== [OPS.save, OPS.setLineWidth, OPS.constructPath, OPS.restore][k]
      ) ||
      q.argsArray[0] !== null ||
      q.argsArray[3] !== null ||
      !(width > 0) ||
      !Number.isFinite(width) ||
      q.argsArray[1].length !== 1 ||
      JSON.stringify(m) !== JSON.stringify([1, 0, 0, 1, 0, 0]) ||
      !Array.isArray(b) ||
      b.length !== 4 ||
      !b.every(Number.isFinite) ||
      b[0] >= b[2] ||
      b[1] >= b[3] ||
      !(a[5] > 0) ||
      !Number.isFinite(a[5]) ||
      a[5] !== a[6] ||
      a[7] !== 2 ||
      a[8] !== 1 ||
      !Array.isArray(line) ||
      line.length !== 3 ||
      line[0] !== OPS.stroke ||
      !Array.isArray(line[1]) ||
      line[1].length !== 1 ||
      !(Array.isArray(path) || ArrayBuffer.isView(path)) ||
      path.length !== 6 ||
      !Array.from(path).every(Number.isFinite) ||
      path[0] !== 0 ||
      path[1] !== 0 ||
      path[2] !== 0 ||
      path[3] !== 1 ||
      !(path[4] > 0) ||
      path[4] !== path[5] ||
      !(Array.isArray(line[2]) || ArrayBuffer.isView(line[2])) ||
      JSON.stringify(Array.from(line[2])) !== JSON.stringify([0, 0, path[4], path[5]])
    )
      return
    const radius = (width * Math.SQRT2) / 2
    if (b[0] > -radius || b[1] > -radius || b[2] < path[4] + radius || b[3] < path[5] + radius)
      return
    patterns.push(a)
    states.set(i, { kind: 'identity-diagonal-hatch-pixel', operationIndex: i })
  }
  if (
    !(sixPanels ? [13] : [3, 6]).includes(patterns.length) ||
    patterns.some((a) => JSON.stringify(a.slice(2)) !== JSON.stringify(patterns[0].slice(2)))
  )
    return
  return states
}
