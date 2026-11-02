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

export const useHomeGalleryNavigation = (): HomeGalleryNavigation => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const [gallery, setGallery] = useState<HTMLElement | null>(null)
  const [scrollable, setScrollable] = useState(false)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [activeSection, setActiveSection] = useState<'projects' | 'examples' | null>(null)

  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content || !gallery) return

    // Both destinations remain available while the shared content can scroll.
    const measure = (): void => {
      setViewportHeight(scroll.clientHeight)
      setScrollable(scroll.scrollHeight > scroll.clientHeight + 1)
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

  return {
    scrollRef,
    contentRef,
    projectsRef,
    galleryRef: setGallery,
    showJump: gallery !== null && scrollable,
    activeSection,
    viewportHeight,
    scrollToProjects: () => scrollToSection(projectsRef.current),
    scrollToGallery: () => scrollToSection(gallery)
  }
}
