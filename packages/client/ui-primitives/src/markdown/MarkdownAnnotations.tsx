/**
 * Document Markdown annotation and review overlay.
 *
 * Implements Google Antigravity-style inline comment workflow:
 * 1. Hover gutter '+' button on blocks (paragraphs, list items, headings)
 * 2. Inline comment box with Add Comment and Cancel
 * 3. Comment badge marker in right gutter with persistent highlight
 * 4. Popover with Delete (red) and Edit Comment (grey) on comment badge
 * 5. Floating selection toolbar with Comment (Ctrl+Alt+M) and Quote (Ctrl+L)
 * 6. Direct insertion of comments and quotes into the Chat Composer.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import clsx from 'clsx'
import { appendTextToComposer, commentToComposer, quoteSelectionToComposer } from './composer-bridge.ts'
import { resolveSourceLocation } from './source-location.ts'
import css from './MarkdownAnnotations.module.css'

export interface MarkdownComment {
  id: string
  text: string
  anchorText: string
  blockIndex: number
  createdAt: number
}

interface ActiveEditorState {
  blockIndex: number
  top: number
  anchorText: string
  initialText: string
  commentId?: string
}

/** Localized labels for markdown annotations UI. */
export interface MarkdownAnnotationsLabels {
  commentAdd: string
  commentSave: string
  commentCancel: string
  commentPlaceholder: string
  commentDelete: string
  commentEdit: string
  commentBadge: string
  commentBadgeCount: string | ((count: number) => string)
  commentQuoted: string
  commentInserted: string
  commentInsertAll: string
  commentInsertAllTitle: string
  selectionComment: string
  selectionQuote: string
  shortcutComment: string
  shortcutQuote: string
}

export interface MarkdownAnnotationsProps {
  children: ReactNode
  resourceAddress: string
  absolutePath?: string | undefined
  sourceText?: string | undefined
  labels: MarkdownAnnotationsLabels
}

function loadComments(address: string): MarkdownComment[] {
  try {
    const raw = localStorage.getItem(`dsh-comment:${address}`)
    if (raw) return JSON.parse(raw) as MarkdownComment[]
  } catch {
    // Fallback to empty list
  }
  return []
}

function saveComments(address: string, comments: MarkdownComment[]): void {
  try {
    localStorage.setItem(`dsh-comment:${address}`, JSON.stringify(comments))
  } catch {
    // Storage quota exceeded or disabled
  }
}

export function MarkdownAnnotations({
  children,
  resourceAddress,
  absolutePath,
  sourceText,
  labels,
}: MarkdownAnnotationsProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const [comments, setComments] = useState<MarkdownComment[]>(() => loadComments(resourceAddress))

  // Update storage whenever comments change
  useEffect(() => {
    saveComments(resourceAddress, comments)
  }, [comments, resourceAddress])

  // Hover gutter '+' button state
  const [hoveredBlock, setHoveredBlock] = useState<{
    index: number
    top: number
    text: string
  } | null>(null)

  // Active inline comment editor state
  const [activeEditor, setActiveEditor] = useState<ActiveEditorState | null>(null)
  const [editorText, setEditorText] = useState('')

  // Active popover card state
  const [activePopover, setActivePopover] = useState<{
    commentId: string
    top: number
  } | null>(null)

  // Floating text selection toolbar state
  const [selectionToolbar, setSelectionToolbar] = useState<{
    x: number
    y: number
    text: string
    blockIndex: number
  } | null>(null)

  // Status notification toast
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((msg: string) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current)
    }
    setToastMessage(msg)
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null)
    }, 2200)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current)
    }
  }, [])

  // Auto-focus editor textarea
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (activeEditor !== null) {
      setEditorText(activeEditor.initialText)
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 50)
    }
  }, [activeEditor])

  // Helper to collect annotatable markdown block elements
  const getAnnotatableBlocks = useCallback((): HTMLElement[] => {
    const root = containerRef.current
    if (!root) return []
    const nodes = root.querySelectorAll<HTMLElement>(
      'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre:not([data-comment-editor])',
    )
    return Array.from(nodes).filter(node => !node.closest('[data-comment-ui]'))
  }, [])

  // Highlight blocks that already have comments
  useLayoutEffect(() => {
    const blocks = getAnnotatableBlocks()
    const commentedIndices = new Set(comments.map(c => c.blockIndex))

    blocks.forEach((block, index) => {
      const hasComment = commentedIndices.has(index)
      if (css.annotatedBlock) {
        if (hasComment) {
          block.classList.add(css.annotatedBlock)
        } else {
          block.classList.remove(css.annotatedBlock)
        }
      }
      if (hasComment) {
        block.setAttribute('data-has-comment', 'true')
      } else {
        block.removeAttribute('data-has-comment')
      }

      if (css.activeTargetBlock) {
        if (activeEditor !== null && activeEditor.blockIndex === index) {
          block.classList.add(css.activeTargetBlock)
        } else {
          block.classList.remove(css.activeTargetBlock)
        }
      }
    })
  }, [comments, activeEditor, getAnnotatableBlocks])

  // Track hover on content to show gutter '+' button (Image 1)
  const handlePointerMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (activeEditor !== null) return

    const root = containerRef.current
    if (!root) return

    const target = e.target as HTMLElement | null
    if (!target) return

    const block = target.closest<HTMLElement>(
      'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre:not([data-comment-editor])',
    )
    if (!block || !root.contains(block) || block.closest('[data-comment-ui]')) {
      return
    }

    const blocks = getAnnotatableBlocks()
    const index = blocks.indexOf(block)
    if (index === -1) return

    const rootRect = root.getBoundingClientRect()
    const blockRect = block.getBoundingClientRect()
    const relativeTop = blockRect.top - rootRect.top + root.scrollTop

    setHoveredBlock({
      index,
      top: relativeTop,
      text: (block.textContent || '').trim(),
    })
  }, [activeEditor, getAnnotatableBlocks])

  const handlePointerLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null
    if (!related || !containerRef.current?.contains(related)) {
      setHoveredBlock(null)
    }
  }, [])

  // Open inline editor from gutter '+' button (Image 2)
  const handleOpenGutterEditor = useCallback(() => {
    if (hoveredBlock === null) return
    setActivePopover(null)
    setActiveEditor({
      blockIndex: hoveredBlock.index,
      top: hoveredBlock.top,
      anchorText: hoveredBlock.text,
      initialText: '',
    })
    setHoveredBlock(null)
  }, [hoveredBlock])

  // Save comment action (Image 2 & 3)
  const handleSaveComment = useCallback(() => {
    if (!activeEditor || !editorText.trim()) return

    const trimmed = editorText.trim()
    const isEdit = Boolean(activeEditor.commentId)

    if (isEdit && activeEditor.commentId) {
      setComments(prev => prev.map(c => (c.id === activeEditor.commentId ? { ...c, text: trimmed } : c)))
    } else {
      const newComment: MarkdownComment = {
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        text: trimmed,
        anchorText: activeEditor.anchorText,
        blockIndex: activeEditor.blockIndex,
        createdAt: Date.now(),
      }
      setComments(prev => [...prev, newComment])

      // Push to Chat Composer
      const loc = resolveSourceLocation(
        resourceAddress,
        absolutePath,
        sourceText,
        activeEditor.anchorText,
        activeEditor.blockIndex,
      )
      commentToComposer(trimmed, activeEditor.anchorText, loc, labels.selectionComment)
      showToast(labels.commentInserted)
    }

    setActiveEditor(null)
    setEditorText('')
  }, [activeEditor, editorText, showToast, labels, resourceAddress, absolutePath, sourceText])

  // Cancel comment editor
  const handleCancelComment = useCallback(() => {
    setActiveEditor(null)
    setEditorText('')
  }, [])

  // Delete comment action (Image 4)
  const handleDeleteComment = useCallback((commentId: string) => {
    setComments(prev => prev.filter(c => c.id !== commentId))
    setActivePopover(null)
  }, [])

  // Edit comment from popover (Image 4)
  const handleStartEditComment = useCallback((comment: MarkdownComment) => {
    const blocks = getAnnotatableBlocks()
    const block = blocks[comment.blockIndex]
    const root = containerRef.current
    let top = 0

    if (block && root) {
      const rootRect = root.getBoundingClientRect()
      const blockRect = block.getBoundingClientRect()
      top = blockRect.top - rootRect.top + root.scrollTop
    }

    setActivePopover(null)
    setActiveEditor({
      blockIndex: comment.blockIndex,
      top,
      anchorText: comment.anchorText,
      initialText: comment.text,
      commentId: comment.id,
    })
  }, [getAnnotatableBlocks])

  // Text Selection detection for Floating Toolbar (Image 5)
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      setSelectionToolbar(null)
      return
    }

    const selectedText = selection.toString().trim()
    if (!selectedText) {
      setSelectionToolbar(null)
      return
    }

    const anchorNode = selection.anchorNode
    const anchorEl = anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement
    const block = anchorEl?.closest<HTMLElement>(
      'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre:not([data-comment-editor])',
    )
    const blocks = getAnnotatableBlocks()
    const blockIndex = block ? blocks.indexOf(block) : 0

    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    // Position floating toolbar below selection
    setSelectionToolbar({
      x: Math.max(10, rect.left + rect.width / 2 - 80),
      y: rect.bottom + 8,
      text: selectedText,
      blockIndex: Math.max(0, blockIndex),
    })
  }, [getAnnotatableBlocks])

  // Comment action from selection toolbar
  const handleCommentSelection = useCallback(() => {
    if (!selectionToolbar) return
    const root = containerRef.current
    const blocks = getAnnotatableBlocks()
    const block = blocks[selectionToolbar.blockIndex]
    let top = 0

    if (block && root) {
      const rootRect = root.getBoundingClientRect()
      const blockRect = block.getBoundingClientRect()
      top = blockRect.top - rootRect.top + root.scrollTop
    }

    setActivePopover(null)
    setActiveEditor({
      blockIndex: selectionToolbar.blockIndex,
      top,
      anchorText: selectionToolbar.text,
      initialText: '',
    })
    setSelectionToolbar(null)
    window.getSelection()?.removeAllRanges()
  }, [selectionToolbar, getAnnotatableBlocks])

  // Quote action from selection toolbar (Ctrl+L)
  const handleQuoteSelection = useCallback(() => {
    if (!selectionToolbar) return
    const loc = resolveSourceLocation(
      resourceAddress,
      absolutePath,
      sourceText,
      selectionToolbar.text,
      selectionToolbar.blockIndex,
    )
    quoteSelectionToComposer(selectionToolbar.text, loc, labels.selectionQuote)
    showToast(labels.commentQuoted)
    setSelectionToolbar(null)
    window.getSelection()?.removeAllRanges()
  }, [selectionToolbar, showToast, labels, resourceAddress, absolutePath, sourceText])

  // Keyboard shortcut listener (Ctrl+Alt+M for Comment, Ctrl+L for Quote)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Alt+M or Cmd+Alt+M
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'm' || e.key === 'M')) {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) {
          e.preventDefault()
          handleCommentSelection()
        }
      }

      // Ctrl+L or Cmd+L
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) {
          e.preventDefault()
          handleQuoteSelection()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleCommentSelection, handleQuoteSelection])

  // Calculate badge positions in right gutter based on actual rendered blocks
  const [badgePositions, setBadgePositions] = useState<Array<{ comment: MarkdownComment; top: number }>>([])

  useLayoutEffect(() => {
    const root = containerRef.current
    if (!root) return

    const blocks = getAnnotatableBlocks()
    const rootRect = root.getBoundingClientRect()

    const positions = comments.map((comment) => {
      const block = blocks[comment.blockIndex]
      if (block) {
        const blockRect = block.getBoundingClientRect()
        return {
          comment,
          top: blockRect.top - rootRect.top + root.scrollTop,
        }
      }
      return { comment, top: 0 }
    })

    setBadgePositions(positions)
  }, [comments, getAnnotatableBlocks])

  const formatBadgeCount = (count: number): string => {
    if (typeof labels.commentBadgeCount === 'function') {
      return labels.commentBadgeCount(count)
    }
    return labels.commentBadgeCount.replace('{n}', String(count))
  }

  return (
    <div
      ref={containerRef}
      className={css.annotationsContainer}
      data-markdown-annotations
      onMouseMove={handlePointerMove}
      onPointerMove={handlePointerMove}
      onMouseLeave={handlePointerLeave}
      onPointerLeave={handlePointerLeave}
      onMouseUp={handleMouseUp}
    >
      {/* Overview Bar above document if comments exist */}
      {comments.length > 0 && (
        <div className={css.commentsOverviewBar} data-comment-ui>
          <div className={css.overviewLeft}>
            <span className={css.overviewBadge}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
              <span>{formatBadgeCount(comments.length)}</span>
            </span>
          </div>
          <div className={css.overviewRight}>
            <button
              type="button"
              className={css.overviewActionBtn}
              onClick={() => {
                const all = comments
                  .map((c) => {
                    const loc = resolveSourceLocation(
                      resourceAddress,
                      absolutePath,
                      sourceText,
                      c.anchorText,
                      c.blockIndex,
                    )
                    return `[Artifact comment on ${loc.markdownLink}]: ${c.text}`
                  })
                  .join('\n\n')
                appendTextToComposer(`${all}\n\n`)
                showToast(labels.commentInserted)
              }}
              title={labels.commentInsertAllTitle}
            >
              {labels.commentInsertAll}
            </button>
          </div>
        </div>
      )}

      {/* Main markdown content */}
      <div className={css.markdownInner}>{children}</div>

      {/* Gutter: Hover '+' Button (Image 1) */}
      {hoveredBlock !== null && activeEditor === null && (
        <button
          type="button"
          className={css.gutterAddButton}
          style={{ top: `${hoveredBlock.top}px` } as CSSProperties}
          onClick={handleOpenGutterEditor}
          title={labels.commentAdd}
          aria-label={labels.commentAdd}
          data-comment-ui
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}

      {/* Gutter: Comment Badges (Image 3) */}
      {badgePositions.map(({ comment, top }) => {
        const isActive = activePopover?.commentId === comment.id
        return (
          <div key={comment.id} data-comment-ui>
            <button
              type="button"
              className={clsx(css.commentBadge, isActive && css.commentBadgeActive)}
              style={{ top: `${top}px` } as CSSProperties}
              onClick={() => {
                setActivePopover(prev => (prev?.commentId === comment.id ? null : { commentId: comment.id, top }))
              }}
              title={labels.commentBadge}
              aria-label={labels.commentBadge}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
            </button>

            {/* Comment Popover Card (Image 4) */}
            {isActive && (
              <div
                className={css.commentPopover}
                style={{ top: `${top}px` } as CSSProperties}
                data-comment-ui
              >
                <div className={css.popoverCommentText}>{comment.text}</div>
                <div className={css.popoverActionsRow}>
                  <button
                    type="button"
                    className={css.popoverDeleteBtn}
                    onClick={() => { handleDeleteComment(comment.id) }}
                  >
                    {labels.commentDelete}
                  </button>
                  <button
                    type="button"
                    className={css.popoverEditBtn}
                    onClick={() => { handleStartEditComment(comment) }}
                  >
                    {labels.commentEdit}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Inline Comment Editor (Image 2) */}
      {activeEditor !== null && (
        <div
          className={css.inlineCommentBox}
          style={{ top: `${activeEditor.top}px` } as CSSProperties}
          data-comment-ui
          data-comment-editor
        >
          <textarea
            ref={textareaRef}
            className={css.commentTextarea}
            value={editorText}
            placeholder={labels.commentPlaceholder}
            onChange={(e) => { setEditorText(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                handleSaveComment()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                handleCancelComment()
              }
            }}
          />
          <div className={css.commentEditorActionsRow}>
            <button
              type="button"
              className={css.editorCancelBtn}
              onClick={handleCancelComment}
            >
              {labels.commentCancel}
            </button>
            <button
              type="button"
              className={css.editorSaveBtn}
              disabled={!editorText.trim()}
              onClick={handleSaveComment}
            >
              {activeEditor.commentId ? labels.commentSave : labels.commentAdd}
            </button>
          </div>
        </div>
      )}

      {/* Floating Selection Toolbar (Image 5) */}
      {selectionToolbar !== null && (
        <div
          className={css.selectionToolbar}
          style={{
            position: 'fixed',
            left: `${selectionToolbar.x}px`,
            top: `${selectionToolbar.y}px`,
          } as CSSProperties}
          data-comment-ui
        >
          <button
            type="button"
            className={css.toolbarBtn}
            onClick={handleCommentSelection}
          >
            <span>{labels.selectionComment}</span>
            <kbd className={css.shortcutKbd}>{labels.shortcutComment}</kbd>
          </button>
          <span className={css.toolbarDivider} />
          <button
            type="button"
            className={css.toolbarBtn}
            onClick={handleQuoteSelection}
          >
            <span>{labels.selectionQuote}</span>
            <kbd className={css.shortcutKbd}>{labels.shortcutQuote}</kbd>
          </button>
        </div>
      )}

      {/* Status toast */}
      {toastMessage !== null && (
        <div className={css.statusToast} data-comment-ui>
          {toastMessage}
        </div>
      )}
    </div>
  )
}
