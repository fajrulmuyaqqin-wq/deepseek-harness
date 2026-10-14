/**
 * The composer's contenteditable host: binds one shell-owned Lexical editor
 * to a resident div. Session-maybe by design — a null editor renders the
 * same DOM inert (the no-session Workspace-trigger state), so switching
 * between the two never swaps the element tree. Editability has ONE writer:
 * this component reflects the `editable` prop onto the editor; nothing else
 * calls setEditable.
 */
import { useLayoutEffect, useRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
  type ParagraphNode,
} from 'lexical'
import { $createReferenceChipNode } from './chip-node.tsx'

/** Host props: the editor binding plus the div passthroughs the bar owns. */
export interface ComposerContentEditableProps extends HTMLAttributes<HTMLDivElement> {
  /** The shell-owned editor; null renders the same div unbound and inert. */
  readonly editor: LexicalEditor | null
  /** Whether the user may edit (readOnly/disabled states fold in here). */
  readonly editable: boolean
}

/**
 * Render the composer's editable surface.
 * @param props - editor binding, editability, and div passthroughs.
 * @returns the resident contenteditable div.
 */
export function ComposerContentEditable({ editor, editable, ...rest }: ComposerContentEditableProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (editor === null || el === null) return
    editor.setRootElement(el)

    const composerApi = {
      getDraft: (): string => {
        let text = ''
        editor.getEditorState().read(() => {
          text = $getRoot().getTextContent()
        })
        return text
      },
      setDraft: (newText: string): void => {
        editor.update(() => {
          const root = $getRoot()
          root.clear()
          for (const line of newText.split('\n')) {
            const paragraph = $createParagraphNode()
            if (line !== '') paragraph.append($createTextNode(line))
            root.append(paragraph)
          }
          root.selectEnd()
        }, { discrete: true })
      },
      prependText: (prefix: string): void => {
        editor.update(() => {
          const root = $getRoot()
          const currentText = root.getTextContent()
          if (!currentText.includes(prefix.trim())) {
            const combined = `${prefix}${currentText}`
            root.clear()
            for (const line of combined.split('\n')) {
              const paragraph = $createParagraphNode()
              if (line !== '') paragraph.append($createTextNode(line))
              root.append(paragraph)
            }
            root.selectEnd()
          }
        }, { discrete: true })
      },
      appendText: (text: string): void => {
        editor.update(() => {
          const root = $getRoot()
          const currentText = root.getTextContent()
          const lead = currentText.length > 0 && !currentText.endsWith('\n') ? '\n\n' : ''
          const combined = `${currentText}${lead}${text}`
          root.clear()
          for (const line of combined.split('\n')) {
            const paragraph = $createParagraphNode()
            if (line !== '') paragraph.append($createTextNode(line))
            root.append(paragraph)
          }
          root.selectEnd()
        }, { discrete: true })
      },
      insertQuoteChip: (quote: {
        snippet: string
        location: { fileName: string; fileUrl: string; markdownLink: string }
      }): void => {
        el.focus()
        editor.focus()
        editor.update(() => {
          const root = $getRoot()
          const cleanSnippet = quote.snippet.replace(/\s+/g, ' ').trim()
          const chipNode = $createReferenceChipNode({
            source: 'reference',
            ref: `> ${quote.location.markdownLink}\n> ${quote.snippet.split('\n').join('\n> ')}\n\n`,
            label: cleanSnippet,
            appearance: 'session',
            clipboardText: `> ${quote.location.markdownLink}\n> ${quote.snippet.split('\n').join('\n> ')}\n\n`,
          })
          const space = $createTextNode(' ')
          const selection = $getSelection()
          if ($isRangeSelection(selection)) {
            selection.insertNodes([chipNode, space])
          } else {
            const children = root.getChildren()
            const last = children[children.length - 1]
            if (last && 'append' in last) {
              (last as ParagraphNode).append(chipNode, space)
            } else {
              const p = $createParagraphNode()
              p.append(chipNode, space)
              root.append(p)
            }
          }
          space.select(1, 1)
        }, { discrete: true })
      },
    }

    ;(el as unknown as { __dshComposer?: typeof composerApi; __lexicalEditor?: LexicalEditor }).__dshComposer = composerApi
    ;(el as unknown as { __dshComposer?: typeof composerApi; __lexicalEditor?: LexicalEditor }).__lexicalEditor = editor

    return () => {
      delete (el as unknown as { __dshComposer?: typeof composerApi; __lexicalEditor?: LexicalEditor }).__dshComposer
      delete (el as unknown as { __dshComposer?: typeof composerApi; __lexicalEditor?: LexicalEditor }).__lexicalEditor
      editor.setRootElement(null)
    }
  }, [editor])
  useLayoutEffect(() => {
    if (editor !== null) editor.setEditable(editable)
  }, [editor, editable])
  return (
    <div
      ref={ref}
      // Lexical's setRootElement never touches contenteditable; the binding
      // renders it, and setEditable above keeps the editor's own gate in step.
      contentEditable={editor !== null && editable}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-composer-input
      {...rest}
    />
  )
}
