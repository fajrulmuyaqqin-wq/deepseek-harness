// @vitest-environment jsdom
/** Tests for markdown source-location and composer-bridge multi-quote and multi-comment element views and background submission. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAllCitations,
  commentToComposer,
  getActiveComments,
  getActiveQuotes,
  quoteSelectionToComposer,
  resolveSourceLocation,
} from '../src/index.ts'

describe('source-location', () => {
  const sourceText = [
    '# Roadmap',
    '',
    '## Step 1: Initial Planning',
    'Define the project requirements and gather resources.',
    'Review existing documentation.',
    '',
    '## Step 2: Implementation',
    'Build the backend services and API handlers.',
    'Construct the UI frontend components.',
  ].join('\n')

  it('resolves exact line numbers for single-line snippet', () => {
    const loc = resolveSourceLocation(
      'dsh-resource://file/var/home/fazdev/plan.md',
      '/var/home/fazdev/plan.md',
      sourceText,
      'Define the project requirements and gather resources.',
      0,
    )

    expect(loc.fileName).toBe('plan.md')
    expect(loc.startLine).toBe(4)
    expect(loc.endLine).toBe(4)
    expect(loc.lineLabel).toBe('plan.md:L4')
    expect(loc.fileUrl).toBe('file:///var/home/fazdev/plan.md#L4')
    expect(loc.markdownLink).toBe('[plan.md:L4](file:///var/home/fazdev/plan.md#L4)')
  })

  it('resolves line range for multi-line snippet', () => {
    const snippet = 'Build the backend services and API handlers.\nConstruct the UI frontend components.'
    const loc = resolveSourceLocation(
      '/workspace/roadmap.md',
      '/workspace/roadmap.md',
      sourceText,
      snippet,
      0,
    )

    expect(loc.fileName).toBe('roadmap.md')
    expect(loc.startLine).toBe(8)
    expect(loc.endLine).toBe(9)
    expect(loc.lineLabel).toBe('roadmap.md:L8-L9')
    expect(loc.fileUrl).toBe('file:///workspace/roadmap.md#L8-L9')
    expect(loc.markdownLink).toBe('[roadmap.md:L8-L9](file:///workspace/roadmap.md#L8-L9)')
  })

  it('falls back gracefully when snippet is not found or source text is missing', () => {
    const loc = resolveSourceLocation(
      'dsh-resource://plan/current',
      undefined,
      undefined,
      'unknown text',
      2,
    )

    expect(loc.startLine).toBe(6)
    expect(loc.fileUrl).toContain('#L6')
    expect(loc.markdownLink).toContain('[current:L6]')
  })
})

describe('composer-bridge', () => {
  let card: HTMLDivElement
  let scrollContainer: HTMLDivElement
  let textarea: HTMLTextAreaElement

  beforeEach(() => {
    clearAllCitations()
    card = document.createElement('div')
    card.setAttribute('data-composer-card', '')

    scrollContainer = document.createElement('div')
    scrollContainer.setAttribute('data-input-scroll', '')

    textarea = document.createElement('textarea')
    textarea.setAttribute('data-composer-input', '')
    scrollContainer.appendChild(textarea)

    const sendBtn = document.createElement('button')
    sendBtn.setAttribute('aria-label', 'Send')
    card.appendChild(scrollContainer)
    card.appendChild(sendBtn)
    document.body.appendChild(card)
  })

  afterEach(() => {
    clearAllCitations()
    card.remove()
    vi.restoreAllMocks()
  })

  it('renders quote chip view inside composer input area (Gambar 2)', () => {
    const loc = resolveSourceLocation(
      '/var/home/fazdev/plan_flexible_plan_mode_architecture.md',
      '/var/home/fazdev/plan_flexible_plan_mode_architecture.md',
      'line 1\nline 2',
      'line 1',
      0,
    )

    quoteSelectionToComposer('line 1', loc, 'Quote')

    const quotesDock = document.querySelector<HTMLElement>('#dsh-composer-quotes-dock')
    expect(quotesDock).not.toBeNull()
    // Inside input container before textarea
    expect(scrollContainer.contains(quotesDock)).toBe(true)
    // Document icon present
    expect(quotesDock?.innerHTML).toContain('<svg')
    // Formatted title: Plan Flexible Plan Mode Architecture
    expect(quotesDock?.textContent).toContain('Plan Flexible Plan Mode Architecture')
    // Snippet preview in quotation marks
    expect(quotesDock?.textContent).toContain('"line 1"')
    expect(getActiveQuotes().length).toBe(1)

    // Remove quote button
    const removeBtn = quotesDock?.querySelector<HTMLButtonElement>('[data-remove-quote]')
    removeBtn?.click()
    expect(document.querySelector('#dsh-composer-quotes-dock')).toBeNull()
    expect(getActiveQuotes().length).toBe(0)
  })

  it('supports multi-quote without overwriting and merges all quotes on submit', () => {
    const loc1 = resolveSourceLocation(
      '/var/home/fazdev/plan.md',
      '/var/home/fazdev/plan.md',
      'Step 1: Setup database\nStep 2: Deploy service',
      'Step 1: Setup database',
      0,
    )
    const loc2 = resolveSourceLocation(
      '/var/home/fazdev/plan.md',
      '/var/home/fazdev/plan.md',
      'Step 1: Setup database\nStep 2: Deploy service',
      'Step 2: Deploy service',
      1,
    )

    quoteSelectionToComposer('Step 1: Setup database', loc1, 'Quote')
    quoteSelectionToComposer('Step 2: Deploy service', loc2, 'Quote')

    expect(getActiveQuotes().length).toBe(2)
    const quotesDock = document.querySelector<HTMLElement>('#dsh-composer-quotes-dock')
    expect(quotesDock?.textContent).toContain('"Step 1: Setup database"')
    expect(quotesDock?.textContent).toContain('"Step 2: Deploy service"')

    // User types draft text
    textarea.value = 'Please review both steps'

    // Submit via Enter
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    // Background prefix merges both quotes
    expect(textarea.value).toContain('> [plan.md:L1](file:///var/home/fazdev/plan.md#L1)')
    expect(textarea.value).toContain('> Step 1: Setup database')
    expect(textarea.value).toContain('> [plan.md:L2](file:///var/home/fazdev/plan.md#L2)')
    expect(textarea.value).toContain('> Step 2: Deploy service')
    expect(textarea.value).toContain('Please review both steps')

    // Citations cleared
    expect(getActiveQuotes().length).toBe(0)
    expect(document.querySelector('#dsh-composer-quotes-dock')).toBeNull()
  })

  it('renders comment count badge above composer input area (Gambar 3)', () => {
    const loc = resolveSourceLocation(
      '/var/home/fazdev/plan.md',
      '/var/home/fazdev/plan.md',
      'line 1\nline 2',
      'line 2',
      1,
    )

    commentToComposer('Needs revision', 'line 2', loc, 'Comment')

    const commentsDock = document.querySelector<HTMLElement>('#dsh-composer-comments-dock')
    expect(commentsDock).not.toBeNull()
    // Positioned in card above inputScroll
    expect(card.contains(commentsDock)).toBe(true)
    expect(scrollContainer.contains(commentsDock)).toBe(false)

    // Outline chat bubble icon present
    expect(commentsDock?.innerHTML).toContain('<svg')
    // Shows "1 Comment"
    expect(commentsDock?.textContent).toContain('1 Comment')
    // Comment text stays in the background (not in textarea)
    expect(textarea.value).toBe('')
    expect(getActiveComments().length).toBe(1)

    // Close button clears comments
    const closeBtn = commentsDock?.querySelector<HTMLButtonElement>('#dsh-comments-close-btn')
    closeBtn?.click()
    expect(document.querySelector('#dsh-composer-comments-dock')).toBeNull()
    expect(getActiveComments().length).toBe(0)
  })

  it('supports multi-comment without overwriting and updates count to 2 Comments', () => {
    const loc1 = resolveSourceLocation(
      '/var/home/fazdev/plan.md',
      '/var/home/fazdev/plan.md',
      'line 1\nline 2',
      'line 1',
      0,
    )
    const loc2 = resolveSourceLocation(
      '/var/home/fazdev/plan.md',
      '/var/home/fazdev/plan.md',
      'line 1\nline 2',
      'line 2',
      1,
    )

    commentToComposer('First note', 'line 1', loc1, 'Comment')
    commentToComposer('Second note', 'line 2', loc2, 'Comment')

    expect(getActiveComments().length).toBe(2)
    const commentsDock = document.querySelector<HTMLElement>('#dsh-composer-comments-dock')
    expect(commentsDock?.textContent).toContain('2 Comments')
    // Text comments stay in background
    expect(textarea.value).toBe('')

    // Submit
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    // Background citations merged with comment text
    expect(textarea.value).toContain('[Artifact comment on [plan.md:L1](file:///var/home/fazdev/plan.md#L1)]')
    expect(textarea.value).toContain('First note')
    expect(textarea.value).toContain('[Artifact comment on [plan.md:L2](file:///var/home/fazdev/plan.md#L2)]')
    expect(textarea.value).toContain('Second note')
    expect(getActiveComments().length).toBe(0)
  })

  it('interacts seamlessly with __dshComposer Lexical API for multi citations', () => {
    let draftValue = ''
    const mockDshComposer = {
      getDraft: () => draftValue,
      setDraft: (val: string) => { draftValue = val },
      prependText: (prefix: string) => { draftValue = `${prefix}${draftValue}` },
      appendText: (text: string) => {
        const lead = draftValue.length > 0 && !draftValue.endsWith('\n') ? '\n\n' : ''
        draftValue = `${draftValue}${lead}${text}`
      },
    }

    const contentEditableDiv = document.createElement('div')
    contentEditableDiv.setAttribute('data-composer-input', '')
    contentEditableDiv.setAttribute('contenteditable', 'true')
    ;(contentEditableDiv as unknown as { __dshComposer: typeof mockDshComposer }).__dshComposer = mockDshComposer

    card.replaceChild(contentEditableDiv, scrollContainer)

    const loc1 = resolveSourceLocation('/workspace/plan.md', '/workspace/plan.md', 'alpha\nbeta', 'alpha', 0)
    const loc2 = resolveSourceLocation('/workspace/plan.md', '/workspace/plan.md', 'alpha\nbeta', 'beta', 1)

    quoteSelectionToComposer('alpha', loc1, 'Quote')
    commentToComposer('Refactor beta', 'beta', loc2, 'Comment')

    expect(getActiveQuotes().length).toBe(1)
    expect(getActiveComments().length).toBe(1)
    // Comment text stays in background before submit
    expect(draftValue).toBe('')

    // Submit
    contentEditableDiv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(draftValue).toContain('> [plan.md:L1](file:///workspace/plan.md#L1)')
    expect(draftValue).toContain('> alpha')
    expect(draftValue).toContain('[Artifact comment on [plan.md:L2](file:///workspace/plan.md#L2)]')
    expect(draftValue).toContain('Refactor beta')
  })

  it('inserts quote chip inline into contenteditable HTML input element without detached dock', () => {
    const contentEditableDiv = document.createElement('div')
    contentEditableDiv.setAttribute('data-composer-input', '')
    contentEditableDiv.setAttribute('contenteditable', 'true')
    card.replaceChild(contentEditableDiv, scrollContainer)

    const loc1 = resolveSourceLocation('/workspace/plan.md', '/workspace/plan.md', 'Line 1\nLine 2', 'Line 1', 0)
    const loc2 = resolveSourceLocation('/workspace/plan.md', '/workspace/plan.md', 'Line 1\nLine 2', 'Line 2', 1)

    quoteSelectionToComposer('Line 1', loc1, 'Quote')
    quoteSelectionToComposer('Line 2', loc2, 'Quote')

    // No detached dock hanging above or outside the input
    expect(document.querySelector('#dsh-composer-quotes-dock')).toBeNull()

    // Inline quote chips are directly inside the contenteditable element
    const inlineChips = contentEditableDiv.querySelectorAll<HTMLElement>('[data-composer-chip="quote"]')
    expect(inlineChips.length).toBe(2)
    expect(inlineChips[0]?.getAttribute('contenteditable')).toBe('false')
    expect(inlineChips[0]?.getAttribute('title')).toBe('Line 1')
    expect(inlineChips[0]?.innerHTML).toContain('<svg')
    expect(inlineChips[0]?.textContent).toContain('Line 1')

    expect(inlineChips[1]?.getAttribute('title')).toBe('Line 2')
    expect(inlineChips[1]?.textContent).toContain('Line 2')
  })

  it('delegates to insertQuoteChip on __dshComposer when available for native Lexical integration', () => {
    let capturedQuote: unknown = null
    const mockDshComposer = {
      getDraft: () => '',
      setDraft: () => {},
      prependText: () => {},
      appendText: () => {},
      insertQuoteChip: (quote: unknown) => {
        capturedQuote = quote
      },
    }

    const contentEditableDiv = document.createElement('div')
    contentEditableDiv.setAttribute('data-composer-input', '')
    contentEditableDiv.setAttribute('contenteditable', 'true')
    ;(contentEditableDiv as unknown as { __dshComposer: typeof mockDshComposer }).__dshComposer = mockDshComposer
    card.replaceChild(contentEditableDiv, scrollContainer)

    const loc = resolveSourceLocation('/workspace/plan.md', '/workspace/plan.md', 'Service setup', 'Service setup', 0)
    quoteSelectionToComposer('Service setup', loc, 'Quote')

    expect(capturedQuote).toEqual({
      snippet: 'Service setup',
      location: loc,
    })
    // No detached dock created
    expect(document.querySelector('#dsh-composer-quotes-dock')).toBeNull()
  })
})
