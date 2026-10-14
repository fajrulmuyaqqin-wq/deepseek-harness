/**
 * Animated Mermaid diagram renderer.
 *
 * Renders fenced mermaid blocks as interactive SVGs with staggered scale-in animations
 * from small to big, making the diagram appear to grow and render element-by-element.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './MermaidBlock.module.css'

export interface MermaidBlockProps {
  /** The raw mermaid diagram source code */
  code: string
  /** Optional class name */
  className?: string | undefined
}

let mermaidInstance: typeof import('mermaid').default | null = null
let mermaidInitPromise: Promise<typeof import('mermaid').default> | null = null

async function getMermaid(): Promise<typeof import('mermaid').default> {
  if (mermaidInstance !== null) return mermaidInstance
  if (mermaidInitPromise !== null) return mermaidInitPromise
  mermaidInitPromise = import('mermaid').then((m) => {
    const instance = m.default ?? m
    instance.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      fontFamily: 'inherit',
      suppressErrorRendering: true,
      darkMode: true,
    })
    mermaidInstance = instance
    return instance
  })
  return mermaidInitPromise
}

export function MermaidBlock({ code, className }: MermaidBlockProps): ReactNode {
  const rawId = useId()
  const diagramId = `mermaid_${rawId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const containerRef = useRef<HTMLDivElement>(null)
  const [svgHtml, setSvgHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let canceled = false
    setError(null)

    getMermaid()
      .then(async (mermaid) => {
        if (canceled) return
        try {
          const { svg } = await mermaid.render(diagramId, code.trim())
          if (!canceled) {
            setSvgHtml(svg)
          }
        } catch (err: unknown) {
          if (!canceled) {
            const message = err instanceof Error ? err.message : String(err)
            setError(message)
          }
        }
      })
      .catch((err) => {
        if (!canceled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })

    return () => {
      canceled = true
    }
  }, [code, diagramId])

  // Apply sequential popping animation to SVG elements
  useEffect(() => {
    const container = containerRef.current
    if (!container || !svgHtml) return

    const elements = container.querySelectorAll<SVGElement>(
      '.node, .cluster, .actor, .actor-line, .messageLine0, .messageLine1, .messageText, .edgePath, .edgeLabel, .task, g.node, g.cluster, g.actor',
    )
    elements.forEach((element, index) => {
      if (css.animatedItem) {
        element.classList.add(css.animatedItem)
      }
      element.style.setProperty('--stagger-index', String(index))
      element.style.animationDelay = `${index * 60}ms`
    })
  }, [svgHtml])

  if (error !== null) {
    return (
      <div className={clsx(css.errorContainer, className)}>
        <pre className={css.errorCode}><code>{code}</code></pre>
      </div>
    )
  }

  return (
    <div className={clsx(css.mermaidWrapper, className)}>
      <div
        ref={containerRef}
        className={css.diagramArea}
        dangerouslySetInnerHTML={svgHtml ? { __html: svgHtml } : undefined}
      />
    </div>
  )
}
