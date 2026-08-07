export type LogoMotionFrame = {
  mode: 'gather' | 'hold' | 'release' | 'field'
  progress: number
}

export type LogoCanvasMetrics = {
  width: number
  height: number
  dpr: number
}

type LogoDot = {
  x: number
  y: number
  radius: number
}

type Point3D = {
  x: number
  y: number
  z: number
}

export type LogoParticle = {
  targetX: number
  targetY: number
  source: Point3D
  radius: number
  phase: number
  delay: number
  alpha: number
}

const LOGO_DOTS: LogoDot[] = [
  { x: -0.012924, y: 0.472892, radius: 0.007784 },
  { x: 0.131586, y: 0.466715, radius: 0.012465 },
  { x: -0.16191, y: 0.448989, radius: 0.012465 },
  { x: 0.062366, y: 0.432197, radius: 0.01001 },
  { x: -0.071564, y: 0.427665, radius: 0.010452 },
  { x: 0.26355, y: 0.406139, radius: 0.007964 },
  { x: 0.192444, y: 0.394296, radius: 0.010934 },
  { x: -0.198676, y: 0.381144, radius: 0.009742 },
  { x: -0.035226, y: 0.371028, radius: 0.009845 },
  { x: -0.294712, y: 0.372418, radius: 0.007964 },
  { x: 0.093762, y: 0.363983, radius: 0.010916 },
  { x: -0.159346, y: 0.333163, radius: 0.008288 },
  { x: 0.304653, y: 0.31767, radius: 0.011835 },
  { x: 0.21201, y: 0.312884, radius: 0.011323 },
  { x: 0.379275, y: 0.305679, radius: 0.012465 },
  { x: 0.03661, y: 0.31467, radius: 0.006839 },
  { x: -0.302793, y: 0.297186, radius: 0.01174 },
  { x: -0.06186, y: 0.308778, radius: 0.005888 },
  { x: 0.130926, y: 0.289632, radius: 0.006601 },
  { x: -0.152828, y: 0.272535, radius: 0.005886 },
  { x: -0.389103, y: 0.259271, radius: 0.012465 },
  { x: -0.263001, y: 0.254961, radius: 0.007069 },
  { x: 0.08035, y: 0.240144, radius: 0.005697 },
  { x: 0.214012, y: 0.236114, radius: 0.007386 },
  { x: 0.301842, y: 0.223886, radius: 0.007543 },
  { x: 0.38527, y: 0.209823, radius: 0.009834 },
  { x: -0.226909, y: 0.209488, radius: 0.007331 },
  { x: -0.379551, y: 0.184014, radius: 0.010332 },
  { x: -0.163488, y: 0.185753, radius: 0.005194 },
  { x: 0.450166, y: 0.175169, radius: 0.007964 },
  { x: 0.277134, y: 0.159357, radius: 0.00851 },
  { x: -0.332208, y: 0.145845, radius: 0.007841 },
  { x: -0.280971, y: 0.125806, radius: 0.005886 },
  { x: -0.453117, y: 0.120612, radius: 0.007964 },
  { x: 0.361206, y: 0.107731, radius: 0.008965 },
  { x: 0.431057, y: 0.08131, radius: 0.009861 },
  { x: 0.311279, y: 0.066881, radius: 0.006979 },
  { x: -0.416624, y: 0.052698, radius: 0.010546 },
  { x: 0.247861, y: 0.053097, radius: 0.005194 },
  { x: 0.486554, y: 0.027388, radius: 0.012467 },
  { x: -0.304731, y: 0.029684, radius: 0.00677 },
  { x: -0.358303, y: 0.018986, radius: 0.010834 },
  { x: 0.379703, y: -0.021576, radius: 0.012119 },
  { x: -0.463213, y: -0.029978, radius: 0.012465 },
  { x: 0.316038, y: -0.032274, radius: 0.005925 },
  { x: 0.434801, y: -0.055291, radius: 0.009139 },
  { x: -0.238767, y: -0.05569, radius: 0.005252 },
  { x: -0.298784, y: -0.069468, radius: 0.006924 },
  { x: -0.413682, y: -0.0839, radius: 0.009003 },
  { x: -0.347098, y: -0.110321, radius: 0.006579 },
  { x: 0.467602, y: -0.123205, radius: 0.007964 },
  { x: 0.292335, y: -0.128399, radius: 0.006867 },
  { x: 0.345213, y: -0.148438, radius: 0.006579 },
  { x: -0.263741, y: -0.16195, radius: 0.006306 },
  { x: -0.43568, y: -0.177762, radius: 0.007964 },
  { x: 0.398485, y: -0.186604, radius: 0.010116 },
  { x: 0.172523, y: -0.188343, radius: 0.005194 },
  { x: -0.365454, y: -0.212416, radius: 0.011512 },
  { x: 0.240177, y: -0.21208, radius: 0.00736 },
  { x: -0.284853, y: -0.226479, radius: 0.010929 },
  { x: -0.202139, y: -0.238706, radius: 0.005886 },
  { x: -0.070817, y: -0.242737, radius: 0.005194 },
  { x: 0.412444, y: -0.261862, radius: 0.012465 },
  { x: 0.277432, y: -0.257553, radius: 0.008802 },
  { x: 0.163226, y: -0.275125, radius: 0.005886 },
  { x: 0.323191, y: -0.299778, radius: 0.010197 },
  { x: -0.119564, y: -0.292222, radius: 0.006152 },
  { x: -0.355934, y: -0.308269, radius: 0.012465 },
  { x: -0.192941, y: -0.315476, radius: 0.009262 },
  { x: 0.073337, y: -0.311369, radius: 0.006979 },
  { x: -0.283451, y: -0.320261, radius: 0.010921 },
  { x: -0.024542, y: -0.317261, radius: 0.006629 },
  { x: 0.176721, y: -0.335756, radius: 0.010578 },
  { x: -0.072535, y: -0.366576, radius: 0.011863 },
  { x: 0.054493, y: -0.37362, radius: 0.010942 },
  { x: 0.309199, y: -0.375011, radius: 0.007964 },
  { x: 0.217238, y: -0.383735, radius: 0.010331 },
  { x: -0.172561, y: -0.396888, radius: 0.010479 },
  { x: -0.249061, y: -0.408731, radius: 0.007964 },
  { x: 0.091052, y: -0.430256, radius: 0.01056 },
  { x: -0.042089, y: -0.434789, radius: 0.011807 },
  { x: 0.185251, y: -0.45158, radius: 0.012465 },
  { x: -0.108245, y: -0.469307, radius: 0.012465 },
  { x: 0.035458, y: -0.484072, radius: 0.007964 }
]

const PARTICLES_PER_DOT = 18
const GOLDEN_ANGLE = 2.399963

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

const easeInOut = (progress: number): number =>
  progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2

const easeOut = (progress: number): number => 1 - Math.pow(1 - progress, 3)

const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0

  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const rotate3D = (point: Point3D, yaw: number, pitch: number): Point3D => {
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)
  const x = point.x * cosYaw - point.z * sinYaw
  const z = point.x * sinYaw + point.z * cosYaw

  return {
    x,
    y: point.y * cosPitch - z * sinPitch,
    z: point.y * sinPitch + z * cosPitch
  }
}

export const resolveLogoFrame = (
  time: number,
  duration: number,
  prefersReducedMotion: boolean
): LogoMotionFrame => {
  if (prefersReducedMotion) return { mode: 'hold', progress: 1 }

  const safeDuration = duration > 0 ? duration : 4800
  const elapsed = ((time % safeDuration) + safeDuration) % safeDuration

  if (elapsed < safeDuration * 0.42) {
    return { mode: 'gather', progress: easeInOut(elapsed / (safeDuration * 0.42)) }
  }
  if (elapsed < safeDuration * 0.58) return { mode: 'hold', progress: 1 }
  if (elapsed < safeDuration * 0.86) {
    return {
      mode: 'release',
      progress: 1 - easeInOut((elapsed - safeDuration * 0.58) / (safeDuration * 0.28))
    }
  }

  return {
    mode: 'field',
    progress: easeOut((elapsed - safeDuration * 0.86) / (safeDuration * 0.14)) * 0.02
  }
}

export const createLogoParticles = (
  metrics: LogoCanvasMetrics,
  seed = 0x5c1e4ce
): LogoParticle[] => {
  const random = createRandom(seed)
  const randomBetween = (minimum: number, maximum: number): number =>
    minimum + random() * (maximum - minimum)
  const logoSize = Math.min(metrics.width, metrics.height) * 0.42
  const centerX = metrics.width / 2
  const centerY = metrics.height / 2
  const count = LOGO_DOTS.length * PARTICLES_PER_DOT

  return Array.from({ length: count }, (_, index) => {
    const dot = LOGO_DOTS[index % LOGO_DOTS.length]
    const pointAngle = index * GOLDEN_ANGLE + randomBetween(-0.18, 0.18)
    const pointRadius = Math.sqrt(random()) * dot.radius
    const pointX = dot.x + Math.cos(pointAngle) * pointRadius
    const pointY = dot.y + Math.sin(pointAngle) * pointRadius
    const sphereRadius = Math.min(metrics.width, metrics.height) * randomBetween(0.24, 0.36)
    const longitude = index * GOLDEN_ANGLE + randomBetween(-0.18, 0.18)
    const latitude = Math.asin(randomBetween(-0.92, 0.92))
    const sourceRadius = sphereRadius * Math.pow(randomBetween(0.58, 1), 0.38)

    return {
      targetX: centerX + pointX * logoSize,
      targetY: centerY + pointY * logoSize,
      source: {
        x: Math.cos(latitude) * Math.cos(longitude) * sourceRadius,
        y: Math.sin(latitude) * sourceRadius * 0.92,
        z: Math.cos(latitude) * Math.sin(longitude) * sourceRadius
      },
      radius: randomBetween(0.68, 1.28) * metrics.dpr,
      phase: randomBetween(0, Math.PI * 2),
      delay: randomBetween(-0.035, 0.05),
      alpha: randomBetween(0.5, 1)
    }
  })
}

const drawResolvedLogo = (
  context: CanvasRenderingContext2D,
  metrics: LogoCanvasMetrics,
  color: string,
  strength: number,
  time: number
): void => {
  if (strength <= 0) return

  const logoSize = Math.min(metrics.width, metrics.height) * 0.42
  const centerX = metrics.width / 2
  const centerY = metrics.height / 2
  const rotation = time * 0.00028
  const breath = 1 + Math.sin(time * 0.0026) * 0.018
  const cosRotation = Math.cos(rotation)
  const sinRotation = Math.sin(rotation)

  context.fillStyle = color
  context.globalAlpha = 0.94 * strength

  for (const dot of LOGO_DOTS) {
    const dotX = dot.x * logoSize * breath
    const dotY = dot.y * logoSize * breath
    const x = centerX + dotX * cosRotation - dotY * sinRotation
    const y = centerY + dotX * sinRotation + dotY * cosRotation

    context.beginPath()
    context.arc(
      x,
      y,
      Math.max(0.8 * metrics.dpr, dot.radius * logoSize * 0.9 * breath),
      0,
      Math.PI * 2
    )
    context.fill()
  }
}

export const drawOpenScienceLogoFrame = (
  context: CanvasRenderingContext2D,
  particles: readonly LogoParticle[],
  metrics: LogoCanvasMetrics,
  color: string,
  frame: LogoMotionFrame,
  time: number
): void => {
  context.clearRect(0, 0, metrics.width, metrics.height)
  context.save()
  context.globalCompositeOperation = 'source-over'
  context.fillStyle = color

  const resolvedStrength = frame.mode === 'hold' ? 1 : clamp((frame.progress - 0.94) / 0.06, 0, 1)
  const particleFade = 1 - resolvedStrength
  const centerX = metrics.width / 2
  const centerY = metrics.height / 2
  const minimumDimension = Math.min(metrics.width, metrics.height)

  for (const particle of particles) {
    const localProgress = clamp(frame.progress + particle.delay, 0, 1)
    const travel = Math.sin(localProgress * Math.PI)
    const settle = Math.pow(localProgress, 3)
    const micro = (1 - settle) * 0.82 * metrics.dpr
    const yaw = time * 0.00034 + particle.phase * 0.03
    const pitch = Math.sin(time * 0.00022 + particle.phase) * 0.16
    const rotated = rotate3D(particle.source, yaw, pitch)
    const perspective = 1 + rotated.z / (minimumDimension * 1.6)
    const depth = clamp((rotated.z / (minimumDimension * 0.36) + 1) / 2, 0, 1)
    const sourceX = centerX + rotated.x * perspective
    const sourceY = centerY + rotated.y * perspective
    const curveX =
      Math.cos(particle.phase + time * 0.0011) * travel * (1 - settle) * 8 * metrics.dpr
    const curveY =
      Math.sin(particle.phase + time * 0.0013) * travel * (1 - settle) * 5.5 * metrics.dpr
    const x =
      sourceX +
      (particle.targetX - sourceX) * localProgress +
      curveX +
      Math.cos(particle.phase + time * 0.0022) * micro
    const y =
      sourceY +
      (particle.targetY - sourceY) * localProgress +
      curveY +
      Math.sin(particle.phase + time * 0.002) * micro
    const depthScale = 0.68 + depth * 0.74
    const radius = particle.radius * depthScale * (0.84 + localProgress * 0.1)
    const opacity = (0.22 + depth * 0.56 + localProgress * 0.16) * particle.alpha * particleFade

    if (opacity < 0.01) continue

    context.globalAlpha = opacity
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }

  drawResolvedLogo(context, metrics, color, resolvedStrength, time)
  context.restore()
}
