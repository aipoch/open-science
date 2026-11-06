import { useEffect, useRef, useState, type RefObject } from 'react'

type HomeGalleryNavigation = {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  projectsRef: RefObject<HTMLDivElement | null>
  galleryRef: (element: HTMLElement | null) => void
  showJump: boolean
  activeSection: 'projects' | 'examples' | null
  viewportHeight: number
  scrollToProjects: () => void
  scrollToGallery: () => void
}

// The capsule rail is a hint that the gallery's first row is mostly out of view.
const firstCaseRowHalfHidden = (scroll: HTMLElement, gallery: HTMLElement): boolean => {
  const cards = [...gallery.querySelectorAll('article')]
  const first = cards[0]
  if (!(first instanceof HTMLElement)) return false
  const firstTop = first.getBoundingClientRect().top
  const row = cards.filter((card) => card.getBoundingClientRect().top <= firstTop + 1)
  const top = Math.min(...row.map((card) => card.getBoundingClientRect().top))
  const bottom = Math.max(...row.map((card) => card.getBoundingClientRect().bottom))
  const height = bottom - top
  if (height <= 0) return false
  const viewport = scroll.getBoundingClientRect()
  const visible = Math.min(bottom, viewport.bottom) - Math.max(top, viewport.top)
  return visible <= height / 2
}

const galleryHeadingBar = (gallery: HTMLElement): HTMLElement => {
  const bar = gallery.querySelector('h2')?.parentElement
  return bar instanceof HTMLElement ? bar : gallery
}

// Sticky paints the heading at the viewport top once it has stuck. The scroll target is the
// heading's place in normal flow, which stays above that painted position.
const galleryHeadingScrollTop = (bar: HTMLElement, scroll: HTMLElement): number => {
  const section = bar.parentElement
  const scrollTop = scroll.getBoundingClientRect().top
  if (!section) return scroll.scrollTop + bar.getBoundingClientRect().top - scrollTop
  const sectionStyle = getComputedStyle(section)
  const barStyle = getComputedStyle(bar)
  const layoutTop =
    section.getBoundingClientRect().top +
    section.clientTop +
    (Number.parseFloat(sectionStyle.paddingTop) || 0) +
    (Number.parseFloat(barStyle.marginTop) || 0)
  return scroll.scrollTop + layoutTop - scrollTop
}

export const useHomeGalleryNavigation = (): HomeGalleryNavigation => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const [gallery, setGallery] = useState<HTMLElement | null>(null)
  const [firstRowHalfHidden, setFirstRowHalfHidden] = useState(false)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [activeSection, setActiveSection] = useState<'projects' | 'examples' | null>(null)

  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content || !gallery) return

    const measure = (): void => {
      setViewportHeight(scroll.clientHeight)
      setFirstRowHalfHidden(firstCaseRowHalfHidden(scroll, gallery))
      // Track the region at the viewport center, including short galleries near the page end.
      const center = scroll.getBoundingClientRect().top + scroll.clientHeight / 2
      const galleryBounds = gallery.getBoundingClientRect()
      const projectBounds = projectsRef.current?.getBoundingClientRect()
      setActiveSection(
        galleryBounds.top <= center && galleryBounds.bottom > center
          ? 'examples'
          : projectBounds && projectBounds.top <= center && projectBounds.bottom > center
            ? 'projects'
            : null
      )
    }
    let frame: number | undefined
    const scheduleMeasure = (): void => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        measure()
      })
    }
    // Status cards may change the viewport height without a window resize.
    const observer = new ResizeObserver(scheduleMeasure)
    for (const element of [scroll, content, gallery]) observer.observe(element)
    window.addEventListener('resize', scheduleMeasure)
    scroll.addEventListener('scroll', scheduleMeasure, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      scroll.removeEventListener('scroll', scheduleMeasure)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [gallery])

  const scrollTo = (top: number): void => {
    scrollRef.current?.scrollTo({
      top,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    })
  }
  const scrollToSection = (section: HTMLElement | null): void => {
    const scroll = scrollRef.current
    if (!scroll || !section) return
    // The fixed region is outside this scroll viewport, so no header offset is needed.
    scrollTo(
      scroll.scrollTop + section.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    )
  }
  const scrollToGallery = (): void => {
    const scroll = scrollRef.current
    if (!scroll || !gallery) return
    // Land on the gallery title, not the pin padding above it.
    scrollTo(galleryHeadingScrollTop(galleryHeadingBar(gallery), scroll))
    // A short homepage may have no native overflow yet. Treat the navigation click as the
    // user's request to reveal the next case batch so the gallery remains reachable.
    if (scroll.scrollHeight <= scroll.clientHeight + 1) scroll.dispatchEvent(new Event('scroll'))
  }

  return {
    scrollRef,
    contentRef,
    projectsRef,
    galleryRef: setGallery,
    showJump: gallery !== null && firstRowHalfHidden,
    activeSection,
    viewportHeight,
    scrollToProjects: () => scrollToSection(projectsRef.current),
    scrollToGallery
  }
}
