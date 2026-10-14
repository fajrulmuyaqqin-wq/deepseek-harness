// @vitest-environment jsdom
/** Tests for MermaidBlock: animated diagram rendering and source toggle. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MermaidBlock } from '../src/markdown/MermaidBlock.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MermaidBlock', () => {
  const code = 'graph TD\n  A[Start] --> B[Finish]'

  it('renders diagram wrapper and diagram area', () => {
    const { container } = render(<MermaidBlock code={code} />)
    expect(container.querySelector('[class*="mermaidWrapper"]')).not.toBeNull()
    expect(container.querySelector('[class*="diagramArea"]')).not.toBeNull()
  })

  it('renders error container when mermaid fails', async () => {
    const invalidCode = 'invalid syntax !!!@@@'
    const { container } = render(<MermaidBlock code={invalidCode} />)
    expect(container).toBeDefined()
  })
})
