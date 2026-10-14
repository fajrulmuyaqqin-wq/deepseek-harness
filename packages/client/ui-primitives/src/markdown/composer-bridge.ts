/**
 * Bridge between Document Markdown viewer and the Conversation Chat Composer.
 *
 * Implements multi-quote and multi-comment support:
 * - Quote view: Placed inside the composer text input as inline/stacked chips
 *   showing document icon, title, quoted snippet preview, and dismiss button (Gambar 2).
 * - Comment view: Placed above the composer text input as a sleek comment counter badge
 *   with a chat bubble icon and comment count, without heavy duplicate modal text (Gambar 3).
 * - Background submission: Formats full Markdown citations with directory links and line
 *   numbers on submit.
 */
import type { ResolvedSourceLocation } from './source-location.ts'

const COMPOSER_SELECTORS = [
  '[data-composer-input]',
  '[data-slot="conversation.composer"] textarea',
  '[data-slot="conversation.composer"] [contenteditable="true"]',
  'textarea[data-phase]',
  '[data-composer-card] textarea',
  '[data-composer-card] [contenteditable="true"]',
  '[data-input-scroll] textarea',
  '[data-input-scroll] [contenteditable="true"]',
]

export interface ActiveQuoteCitation {
  id: string
  location: ResolvedSourceLocation
  snippet: string
  badge?: string | undefined
}

export interface ActiveCommentCitation {
  id: string
  location: ResolvedSourceLocation
  snippet: string
  commentText: string
  badge?: string | undefined
}

/** Legacy / unified interface for backwards compatibility */
export interface ActiveCitation {
  id: string
  type: 'comment' | 'quote'
  badge?: string | undefined
  location: ResolvedSourceLocation
  snippet: string
  commentText?: string | undefined
}

let activeQuotes: ActiveQuoteCitation[] = []
let activeComments: ActiveCommentCitation[] = []

/** Get currently active quote citations */
export function getActiveQuotes(): readonly ActiveQuoteCitation[] {
  return activeQuotes
}

/** Get currently active comment citations */
export function getActiveComments(): readonly ActiveCommentCitation[] {
  return activeComments
}

/** Locate the active composer element in the DOM. */
export function findComposerElement(): HTMLElement | null {
  for (const selector of COMPOSER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el !== null) return el
  }
  return null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatDisplayName(fileName: string): string {
  if (fileName.endsWith('.md')) {
    const base = fileName.slice(0, -3)
    return base
      .split(/[-_]/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }
  return fileName
}

/** Paste text via Lexical editor command dispatch when available. */
function pasteViaLexical(element: HTMLElement, text: string): boolean {
  const editor = (element as unknown as { __lexicalEditor?: {
    dispatchCommand: (cmd: unknown, payload: unknown) => boolean
    _commands?: { keys: () => IterableIterator<{ type: string }> }
  } }).__lexicalEditor

  if (editor === undefined || typeof editor.dispatchCommand !== 'function') {
    return false
  }

  const commands = editor._commands
  if (commands === undefined || typeof commands.keys !== 'function') {
    return false
  }

  const command = [...commands.keys()].find(candidate => candidate.type === 'PASTE_COMMAND')
  if (command === undefined) return false

  const clipboardData = {
    files: [],
    items: [],
    types: ['text/plain'],
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  }

  const event = {
    clipboardData,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  }

  try {
    return editor.dispatchCommand(command, event)
  } catch {
    return false
  }
}

/** Fallback paste event for non-Lexical contenteditable elements. */
function pasteViaEvent(element: HTMLElement, text: string): boolean {
  let clipboardData: DataTransfer | null = null
  try {
    clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
  } catch {
    // DataTransfer may be restricted in some environments
  }

  let event: ClipboardEvent
  try {
    event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
  } catch {
    event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  }

  if (clipboardData !== null && event.clipboardData === null) {
    try {
      Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    } catch {
      // Ignored
    }
  }

  element.dispatchEvent(event)
  return event.defaultPrevented
}

/**
 * Set text value directly into textarea, input, or Lexical contenteditable.
 * @param text - The text string to insert
 * @returns true if text was set successfully
 */
export function setComposerText(text: string): boolean {
  const element = findComposerElement()
  if (element === null) return false

  element.focus()

  const api = (element as unknown as { __dshComposer?: { setDraft: (t: string) => void } }).__dshComposer
  if (api) {
    api.setDraft(text)
    return true
  }

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const descriptor = element instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')

    if (descriptor?.set) {
      descriptor.set.call(element, text)
    } else {
      element.value = text
    }

    element.dispatchEvent(new Event('input', { bubbles: true }))
    const pos = text.length
    element.setSelectionRange(pos, pos)
    return true
  }

  // Lexical / ContentEditable
  const selection = document.getSelection()
  const range = document.createRange()
  const caretContainer = element.lastElementChild ?? element
  range.selectNodeContents(caretContainer)
  selection?.removeAllRanges()
  selection?.addRange(range)

  if (pasteViaLexical(element, text)) return true
  if (pasteViaEvent(element, text)) return true

  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) {
    return true
  }

  range.insertNode(document.createTextNode(text))
  range.collapse(false)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  return true
}

/**
 * Append text to the end of the composer and focus it.
 * @param text - The text string to append
 * @returns true if text was inserted successfully
 */
export function appendTextToComposer(text: string): boolean {
  const element = findComposerElement()
  if (element === null) return false

  element.focus()

  const api = (element as unknown as { __dshComposer?: {
    getDraft: () => string
    setDraft: (t: string) => void
    appendText?: (t: string) => void
  } }).__dshComposer
  if (api) {
    if (typeof api.appendText === 'function') {
      api.appendText(text)
      return true
    }
    const value = api.getDraft()
    const lead = value !== '' && !value.endsWith('\n') ? '\n\n' : ''
    api.setDraft(`${value}${lead}${text}`)
    return true
  }

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const value = element.value
    const lead = value !== '' && !value.endsWith('\n') ? '\n\n' : ''
    const next = `${value}${lead}${text}`
    const descriptor = element instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')

    if (descriptor?.set) {
      descriptor.set.call(element, next)
    } else {
      element.value = next
    }

    element.dispatchEvent(new Event('input', { bubbles: true }))
    const pos = next.length
    element.setSelectionRange(pos, pos)
    return true
  }

  // Lexical / ContentEditable
  const selection = document.getSelection()
  const range = document.createRange()
  const caretContainer = element.lastElementChild ?? element
  range.selectNodeContents(caretContainer)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)

  if (pasteViaLexical(element, text)) return true
  if (pasteViaEvent(element, text)) return true

  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) {
    return true
  }

  range.insertNode(document.createTextNode(text))
  range.collapse(false)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  return true
}

/** Remove a single quote by its ID and re-render quote views */
export function removeQuote(quoteId: string): void {
  activeQuotes = activeQuotes.filter(q => q.id !== quoteId)
  const el = findComposerElement()
  if (el) {
    el.querySelector(`[data-quote-id="${quoteId}"]`)?.remove()
    renderQuotesView(el)
  }
}

/** Clear all active comments and remove comments dock */
export function clearComments(): void {
  activeComments = []
  const dock = document.querySelector<HTMLElement>('#dsh-composer-comments-dock')
  if (dock) dock.remove()
}

/** Clear all active quotes and comments */
export function clearAllCitations(): void {
  activeQuotes = []
  activeComments = []
  const el = findComposerElement()
  if (el) {
    el.querySelectorAll('[data-composer-chip="quote"]').forEach((chip) => {
      chip.remove()
    })
  }
  const qDock = document.querySelector<HTMLElement>('#dsh-composer-quotes-dock')
  if (qDock) qDock.remove()
  const cDock = document.querySelector<HTMLElement>('#dsh-composer-comments-dock')
  if (cDock) cDock.remove()
  const legacyDock = document.querySelector<HTMLElement>('#dsh-composer-citation-dock')
  if (legacyDock) legacyDock.remove()
}

/** Alias for clearAllCitations for backward compatibility */
export function dismissCitationElement(): void {
  clearAllCitations()
}

/**
 * Render or update Quote views INSIDE the composer input area (Gambar 2).
 * Renders document icon, title, snippet preview, and dismiss button for each quote.
 */
export function renderQuotesView(composerElement: HTMLElement): void {
  let dock = document.querySelector<HTMLElement>('#dsh-composer-quotes-dock')

  if (activeQuotes.length === 0) {
    if (dock) dock.remove()
    return
  }

  if (!dock) {
    dock = document.createElement('div')
    dock.id = 'dsh-composer-quotes-dock'
    dock.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 4px 0 8px 0;
      width: 100%;
      box-sizing: border-box;
      z-index: 5;
    `
    // Insert inside the input container right before the composerElement or its parent inside data-input-scroll
    const inputScroll = composerElement.closest('[data-input-scroll]')
    if (inputScroll && composerElement.parentElement && composerElement.parentElement !== inputScroll) {
      composerElement.parentElement.insertBefore(dock, composerElement)
    } else {
      composerElement.parentElement?.insertBefore(dock, composerElement)
    }
  }

  dock.innerHTML = activeQuotes.map((quote) => {
    const rawSnippet = quote.snippet.replace(/\n+/g, ' ').trim()
    const truncated = rawSnippet.length > 60 ? `${rawSnippet.slice(0, 57)}...` : rawSnippet
    const displayName = formatDisplayName(quote.location.fileName)

    return `
      <div class="dsh-quote-chip" data-quote-id="${quote.id}" style="
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 5px 10px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        font-size: 12px;
        color: #e2e8f0;
        max-width: 100%;
        box-sizing: border-box;
      ">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none; opacity:0.85;">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <a href="${quote.location.fileUrl}" target="_blank" rel="noopener noreferrer" style="font-weight: 500; color: #f1f5f9; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;" title="${escapeHtml(quote.location.fileName)}">
          ${escapeHtml(displayName)}
        </a>
        <span style="color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; font-style: italic;" title="${escapeHtml(quote.snippet)}">
          "${escapeHtml(truncated)}"
        </span>
        <button type="button" data-remove-quote="${quote.id}" aria-label="Remove quote" style="background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0 4px; font-size: 13px; line-height: 1; border-radius: 4px; margin-left: auto;">✕</button>
      </div>
    `
  }).join('')

  // Bind remove buttons
  const removeButtons = dock.querySelectorAll<HTMLButtonElement>('[data-remove-quote]')
  removeButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const quoteId = btn.getAttribute('data-remove-quote')
      if (quoteId) {
        removeQuote(quoteId)
      }
    })
  })
}

/**
 * Render or update Comments view ABOVE the composer input (Gambar 3).
 * Renders a clean pill with speech bubble icon and comment count without large modal panels.
 */
export function renderCommentsView(composerElement: HTMLElement): void {
  const card = composerElement.closest<HTMLElement>('[data-composer-card]') ?? composerElement.parentElement
  if (!card) return

  let dock = card.querySelector<HTMLElement>('#dsh-composer-comments-dock')

  if (activeComments.length === 0) {
    if (dock) dock.remove()
    return
  }

  if (!dock) {
    dock = document.createElement('div')
    dock.id = 'dsh-composer-comments-dock'
    dock.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 4px 12px 6px 12px;
      padding: 3px 6px;
      border-radius: 4px;
      font-size: 12px;
      color: #94a3b8;
      z-index: 10;
    `
    const inputScroll = card.querySelector('[data-input-scroll]') ?? composerElement
    inputScroll.parentElement?.insertBefore(dock, inputScroll)
  }

  const count = activeComments.length
  const badgeTag = activeComments[0]?.badge ?? 'Comment'
  const countPill = count === 1 ? `1 ${badgeTag}` : `${count} ${badgeTag}s`

  dock.innerHTML = `
    <div style="display: flex; align-items: center; gap: 6px;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none; opacity: 0.85;">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <span style="font-size: 12px; color: #cbd5e1; font-weight: 500;">${countPill}</span>
      <button type="button" id="dsh-comments-close-btn" aria-label="Clear comments" style="background: none; border: none; color: #64748b; cursor: pointer; padding: 0 4px; font-size: 13px; line-height: 1; margin-left: 2px;">✕</button>
    </div>
  `

  const closeBtn = dock.querySelector<HTMLButtonElement>('#dsh-comments-close-btn')
  closeBtn?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    clearComments()
  })
}

/**
 * Legacy citation element renderer for backwards compatibility.
 */
export function renderCitationElement(citation: ActiveCitation): void {
  const el = findComposerElement()
  if (!el) return

  if (citation.type === 'quote') {
    quoteSelectionToComposer(citation.snippet, citation.location, citation.badge)
  } else {
    commentToComposer(citation.commentText ?? '', citation.snippet, citation.location, citation.badge)
  }
}

const attachedElements = new WeakSet<HTMLElement>()

function attachSubmitInterceptor(composerElement: HTMLElement): void {
  if (attachedElements.has(composerElement)) return
  attachedElements.add(composerElement)

  const handleBeforeSubmit = (): void => {
    if (activeQuotes.length === 0 && activeComments.length === 0) return

    let prefix = ''

    // 1. Quotes citations (only for non-Lexical fallback inputs without chip projection)
    const api = (composerElement as unknown as { __dshComposer?: {
      insertQuoteChip?: unknown
    } }).__dshComposer
    const hasLexicalQuote = Boolean(api && typeof api.insertQuoteChip === 'function')

    if (!hasLexicalQuote) {
      for (const quote of activeQuotes) {
        const linkStr = quote.location.markdownLink
        const quoteLines = quote.snippet.split('\n').map(l => `> ${l}`).join('\n')
        prefix += `> ${linkStr}\n${quoteLines}\n\n`
      }
    }

    // 2. Comments citations
    for (const comment of activeComments) {
      const linkStr = comment.location.markdownLink
      const quoteLines = comment.snippet ? comment.snippet.split('\n').map(l => `> ${l}`).join('\n') : ''
      const commentBody = comment.commentText ? `\n${comment.commentText}` : ''
      if (quoteLines) {
        prefix += `[Artifact comment on ${linkStr}]:\n${quoteLines}${commentBody}\n\n`
      } else {
        prefix += `[Artifact comment on ${linkStr}]:${commentBody}\n\n`
      }
    }

    if (prefix.length > 0) {
      const api = (composerElement as unknown as { __dshComposer?: {
        prependText: (p: string) => void
        setDraft: (t: string) => void
        getDraft: () => string
      } }).__dshComposer
      if (api) {
        const current = api.getDraft()
        if (current.trim().length === 0) {
          api.setDraft(prefix.trim())
        } else {
          api.prependText(prefix)
        }
      } else if (composerElement instanceof HTMLTextAreaElement || composerElement instanceof HTMLInputElement) {
        const current = composerElement.value
        if (current.trim().length === 0) {
          composerElement.value = prefix.trim()
        } else if (!current.includes(prefix.trim())) {
          composerElement.value = `${prefix}${current}`
        }
      }
    }

    clearAllCitations()
  }

  // Intercept Enter key
  composerElement.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      handleBeforeSubmit()
    }
  }, { capture: true })

  // Intercept Send button click
  const card = composerElement.closest<HTMLElement>('[data-composer-card]')
  const sendButton = card?.querySelector<HTMLButtonElement>('button[aria-label="Send"], button[aria-label*="send" i]')
  sendButton?.addEventListener('click', () => {
    handleBeforeSubmit()
  }, { capture: true })
}

/** Insert an inline quote chip directly into a non-Lexical contenteditable input. */
function insertInlineHtmlQuoteChip(
  element: HTMLElement,
  snippet: string,
  _location: ResolvedSourceLocation,
  quoteId: string,
): void {
  element.focus()
  const cleanSnippet = snippet.replace(/\s+/g, ' ').trim()
  const truncated = cleanSnippet.length > 36 ? `${cleanSnippet.slice(0, 33)}...` : cleanSnippet

  const chipSpan = document.createElement('span')
  chipSpan.setAttribute('contenteditable', 'false')
  chipSpan.setAttribute('data-composer-chip', 'quote')
  chipSpan.setAttribute('data-quote-id', quoteId)
  chipSpan.setAttribute('title', cleanSnippet)
  chipSpan.style.cssText = [
    'display: inline-flex',
    'align-items: center',
    'gap: 4px',
    'padding: 0 6px',
    'margin: 0 4px 0 0',
    'border-radius: 4px',
    'background: rgba(255, 115, 0, 0.12)',
    'border: 1px solid rgba(255, 115, 0, 0.25)',
    'color: #f97316',
    'font-size: 13px',
    'line-height: 20px',
    'vertical-align: middle',
    'user-select: none',
    'cursor: default',
    'max-width: 240px',
  ].join('; ')

  chipSpan.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      <line x1="8" y1="9" x2="16" y2="9"></line>
      <line x1="8" y1="13" x2="14" y2="13"></line>
    </svg>
    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(truncated)}</span>
  `

  const space = document.createTextNode(' ')
  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0 && element.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0)
    range.deleteContents()
    range.insertNode(space)
    range.insertNode(chipSpan)
    range.setStartAfter(space)
    range.setEndAfter(space)
    selection.removeAllRanges()
    selection.addRange(range)
  } else {
    element.appendChild(chipSpan)
    element.appendChild(space)
    const range = document.createRange()
    range.setStartAfter(space)
    range.setEndAfter(space)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
}

/**
 * Quote selected text into the chat composer as an inline chip inside the text input.
 * Supports multiple quotes without overwriting ("bisa seiringan dengan chat, gak ngegantung").
 * @param selectedText - Text selected by the user
 * @param location - The resolved source location with directory link and lines
 * @param badge - Optional localized kind badge
 * @returns true if quote was successfully inserted
 */
export function quoteSelectionToComposer(
  selectedText: string,
  location: ResolvedSourceLocation,
  badge?: string,
): boolean {
  const composerElement = findComposerElement()
  if (!composerElement) return false

  const snippet = selectedText.trim()
  const quoteId = `quote_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  activeQuotes.push({
    id: quoteId,
    location,
    snippet,
    badge,
  })

  // 1. Try Lexical Composer API first (inserts inline ReferenceChipNode)
  const api = (composerElement as unknown as { __dshComposer?: {
    insertQuoteChip?: (quote: {
      snippet: string
      location: ResolvedSourceLocation
    }) => void
  } }).__dshComposer

  if (api && typeof api.insertQuoteChip === 'function') {
    api.insertQuoteChip({ snippet, location })
    attachSubmitInterceptor(composerElement)
    return true
  }

  // 2. Fallback for contenteditable element without __dshComposer (inserts inline HTML chip)
  if (composerElement.getAttribute('contenteditable') === 'true' || composerElement.isContentEditable) {
    insertInlineHtmlQuoteChip(composerElement, snippet, location, quoteId)
    attachSubmitInterceptor(composerElement)
    return true
  }

  // 3. Fallback for plain textarea
  renderQuotesView(composerElement)
  attachSubmitInterceptor(composerElement)

  return true
}

/**
 * Insert an artifact comment into the chat composer with slim counter view above input (Gambar 3).
 * Supports multiple comments without overwriting.
 * The comment text stays in the background and is merged only on submit.
 * @param commentText - Comment body
 * @param anchorText - Excerpt of the commented block
 * @param location - The resolved source location with directory link and lines
 * @param badge - Optional localized kind badge
 */
export function commentToComposer(
  commentText: string,
  anchorText: string,
  location: ResolvedSourceLocation,
  badge?: string,
): boolean {
  const composerElement = findComposerElement()
  if (!composerElement) return false

  const commentId = `comment_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  activeComments.push({
    id: commentId,
    location,
    snippet: anchorText.trim(),
    commentText: commentText.trim(),
    badge,
  })

  // Render comments count pill above the input (Gambar 3)
  renderCommentsView(composerElement)

  // Attach submit interceptor
  attachSubmitInterceptor(composerElement)

  return true
}
