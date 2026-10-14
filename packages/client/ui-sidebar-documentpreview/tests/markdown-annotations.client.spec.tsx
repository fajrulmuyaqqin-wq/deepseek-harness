// @vitest-environment jsdom
/** Tests for MarkdownAnnotations: gutter +, inline comments, popovers, and selection actions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MarkdownAnnotations } from '../src/client/markdown/MarkdownAnnotations.tsx'
import { en } from '../src/client/markdown/locales.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('MarkdownAnnotations', () => {
  const resourceAddress = 'dsh-resource://file/workspace/plan.md'
  const t = makeTranslate(en)

  it('renders children inside annotations container', () => {
    const { container } = render(
      <MarkdownAnnotations resourceAddress={resourceAddress} t={t}>
        <p>First paragraph</p>
        <p>Second paragraph</p>
      </MarkdownAnnotations>,
    )
    expect(container.querySelector('[data-markdown-annotations]')).toBeDefined()
    expect(screen.getByText('First paragraph')).toBeDefined()
  })

  it('shows gutter add button on mouse move over block and opens inline editor', async () => {
    const { container } = render(
      <MarkdownAnnotations resourceAddress={resourceAddress} t={t}>
        <p data-testid="p1">First paragraph to comment</p>
      </MarkdownAnnotations>,
    )

    const p1 = screen.getByTestId('p1')
    fireEvent.mouseMove(p1)

    // Gutter add button should appear
    const addBtn = container.querySelector('button[aria-label="Add Comment"]')
    expect(addBtn).toBeDefined()
    expect(addBtn).not.toBeNull()

    // Click to open editor
    if (addBtn) {
      fireEvent.click(addBtn)
    }

    // Inline comment box should appear
    const textarea = screen.getByPlaceholderText('Leave a comment') as HTMLTextAreaElement
    expect(textarea).toBeDefined()
    expect(screen.getByText('Add Comment')).toBeDefined()
    expect(screen.getByText('Cancel')).toBeDefined()

    // Type a comment
    fireEvent.change(textarea, { target: { value: 'Revise this step' } })
    expect(textarea.value).toBe('Revise this step')

    // Submit comment
    const saveBtn = screen.getByRole('button', { name: 'Add Comment' })
    fireEvent.click(saveBtn)

    // Comment badge should now be in the gutter
    const commentBadge = container.querySelector('button[aria-label="Comment"]')
    expect(commentBadge).not.toBeNull()

    // Persistent highlight should be applied to the block
    expect(p1.getAttribute('data-has-comment')).toBe('true')
  })

  it('opens popover on comment badge click with Delete and Edit options', async () => {
    // Pre-populate comment in localStorage
    localStorage.setItem(
      `dsh-comment:${resourceAddress}`,
      JSON.stringify([
        {
          id: 'c_test_1',
          text: 'Pre-existing review note',
          anchorText: 'Target block',
          blockIndex: 0,
          createdAt: Date.now(),
        },
      ]),
    )

    const { container } = render(
      <MarkdownAnnotations resourceAddress={resourceAddress} t={t}>
        <p data-testid="p0">Target block</p>
      </MarkdownAnnotations>,
    )

    // Badge should be rendered
    const badge = container.querySelector('button[aria-label="Comment"]')
    expect(badge).not.toBeNull()

    // Click badge to open popover
    if (badge) {
      fireEvent.click(badge)
    }

    // Popover content should be visible
    expect(screen.getByText('Pre-existing review note')).toBeDefined()
    expect(screen.getByText('Delete')).toBeDefined()
    expect(screen.getByText('Edit Comment')).toBeDefined()

    // Delete comment
    const deleteBtn = screen.getByText('Delete')
    fireEvent.click(deleteBtn)

    // Badge and popover should be gone
    expect(container.querySelector('button[aria-label="Comment"]')).toBeNull()
    expect(screen.queryByText('Pre-existing review note')).toBeNull()
  })

  it('cancels inline comment when clicking Cancel', () => {
    const { container } = render(
      <MarkdownAnnotations resourceAddress={resourceAddress} t={t}>
        <p data-testid="p1">Target block</p>
      </MarkdownAnnotations>,
    )

    const p1 = screen.getByTestId('p1')
    fireEvent.mouseMove(p1)

    const addBtn = container.querySelector('button[aria-label="Add Comment"]')
    if (addBtn) {
      fireEvent.click(addBtn)
    }

    expect(screen.getByPlaceholderText('Leave a comment')).toBeDefined()

    const cancelBtn = screen.getByText('Cancel')
    fireEvent.click(cancelBtn)

    expect(screen.queryByPlaceholderText('Leave a comment')).toBeNull()
  })

  it('allows editing an existing comment', async () => {
    localStorage.setItem(
      `dsh-comment:${resourceAddress}`,
      JSON.stringify([
        {
          id: 'c_edit_test',
          text: 'Initial comment',
          anchorText: 'Target block',
          blockIndex: 0,
          createdAt: Date.now(),
        },
      ]),
    )

    const { container } = render(
      <MarkdownAnnotations resourceAddress={resourceAddress} t={t}>
        <p data-testid="p0">Target block</p>
      </MarkdownAnnotations>,
    )

    // Open popover
    const badge = container.querySelector('button[aria-label="Comment"]')
    if (badge) fireEvent.click(badge)

    // Click edit
    const editBtn = screen.getByText('Edit Comment')
    fireEvent.click(editBtn)

    // Textarea should contain existing comment
    const textarea = screen.getByPlaceholderText('Leave a comment') as HTMLTextAreaElement
    expect(textarea.value).toBe('Initial comment')

    // Change and save
    fireEvent.change(textarea, { target: { value: 'Updated comment' } })
    const saveBtn = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(saveBtn)

    // Verify localStorage has updated text
    const stored = JSON.parse(localStorage.getItem(`dsh-comment:${resourceAddress}`) ?? '[]')
    expect(stored[0]?.text).toBe('Updated comment')
  })

  it('inserts quote and comment into mock composer element', () => {
    // Mount a mock composer textarea in document body
    const composer = document.createElement('textarea')
    composer.setAttribute('data-composer-input', '')
    document.body.appendChild(composer)

    const { container } = render(
      <MarkdownAnnotations resourceAddress={resourceAddress} t={t}>
        <p data-testid="p0">Selectable text</p>
      </MarkdownAnnotations>,
    )

    const p0 = screen.getByTestId('p0')
    fireEvent.mouseMove(p0)

    const addBtn = container.querySelector('button[aria-label="Add Comment"]')
    if (addBtn) fireEvent.click(addBtn)

    const textarea = screen.getByPlaceholderText('Leave a comment') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Please adjust this plan' } })
    const saveBtn = screen.getByRole('button', { name: 'Add Comment' })
    fireEvent.click(saveBtn)

    // Verify comments element view appears above composer while text stays in background
    expect(document.querySelector('#dsh-composer-comments-dock')).not.toBeNull()
    expect(composer.value).toBe('')

    // On submit (Enter), background citation with comment text is submitted
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(composer.value).toContain('[Artifact comment on')
    expect(composer.value).toContain('Please adjust this plan')

    composer.remove()
  })
})
