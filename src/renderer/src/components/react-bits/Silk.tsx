import { useEffect, useRef } from 'react'

// Card-only version of the React Bits Silk field. Render into one scratch GL surface and
// keep the last painted bitmap in each card: the carousel exceeds Chromium's GL context limit.
type Paint = (ctx: CanvasRenderingContext2D, color: string, time: number) => void

function createPainter(): Paint | null {
  const surface = document.createElement('canvas')
  const gl = surface.getContext('webgl2', { alpha: false, antialias: false, depth: false })
  if (!gl) return null
  const program = gl.createProgram()
  if (!program) return null
  for (const [type, source] of [
    [
      gl.VERTEX_SHADER,
      `#version 300 es
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(p * 2.0 - 1.0, 0., 1.);
      }`
    ],
    [
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      uniform vec2 size;
      uniform vec3 tint;
      uniform float time;
      out vec4 pixel;
      void main() {
        vec2 tex = gl_FragCoord.xy / size * 1.44;
        tex.y += .0135 * sin(8. * tex.x - time);
        float fold = .5 + .5 * sin(5. * (tex.x + tex.y + cos(3. * tex.x + 5. * tex.y) + .02 * time));
        vec2 r = 2.71828 * sin(2.71828 * gl_FragCoord.xy);
        float grain = fract(r.x * r.y * (1. + gl_FragCoord.x)) - .5;
        vec3 shadow = mix(vec3(.055), tint, .23);
        vec3 sheen = mix(tint, vec3(1.), .34);
        pixel = vec4(mix(shadow, sheen, pow(fold, 2.4)) + grain * .065, 1.);
      }`
    ]
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) {
      gl.deleteProgram(program)
      return null
    }
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  gl.useProgram(program)
  const size = gl.getUniformLocation(program, 'size')
  const tint = gl.getUniformLocation(program, 'tint')
  const phase = gl.getUniformLocation(program, 'time')
  return (ctx, color, time): void => {
    const { width, height } = ctx.canvas
    if (gl.isContextLost()) return
    if (surface.width !== width) surface.width = width
    if (surface.height !== height) surface.height = height
    const rgb = Number.parseInt(color.slice(1), 16)
    gl.viewport(0, 0, width, height)
    gl.uniform2f(size, width, height)
    gl.uniform3f(tint, (rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255)
    gl.uniform1f(phase, time)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    ctx.drawImage(surface, 0, 0)
  }
}

let painter: Paint | null | undefined
let cards = 0

export default function Silk({
  color,
  paused
}: {
  color: string
  paused: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const phase = useRef(0)
  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')
    if (painter === undefined) painter = createPainter()
    const paint = painter
    if (!ctx || !paint) return
    cards++
    const draw = (): void => paint(ctx, color, phase.current)
    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.25)
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      draw()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let previous = 0
    const tick = (now: number): void => {
      phase.current += previous ? Math.min(now - previous, 50) * 0.001 : 0
      previous = now
      draw()
      frame = requestAnimationFrame(tick)
    }
    const update = (): void => {
      cancelAnimationFrame(frame)
      previous = 0
      if (!paused && !motion.matches && !document.hidden) frame = requestAnimationFrame(tick)
    }
    update()
    motion.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      // Release the shared renderer once the carousel is unmounted. A hover change also
      // cleans up this effect, but the other cards retain their renderer.
      if (--cards === 0) painter = undefined
      cancelAnimationFrame(frame)
      observer.disconnect()
      motion.removeEventListener('change', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [color, paused])
  return <canvas aria-hidden="true" ref={ref} className="absolute inset-0 block size-full" />
}
