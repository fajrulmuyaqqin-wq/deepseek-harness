/**
 * Markdown annotations adapter for ui-sidebar-documentpreview.
 * Maps localized copy into primitive MarkdownAnnotations.
 */
import type { ReactNode } from 'react'
import {
  MarkdownAnnotations as BaseMarkdownAnnotations,
  type MarkdownAnnotationsLabels,
  type MarkdownComment,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownPreviewKey } from './locales.ts'

export type { MarkdownComment }

export interface MarkdownAnnotationsProps {
  children: ReactNode
  resourceAddress: string
  absolutePath?: string | undefined
  sourceText?: string | undefined
  t: (key: MarkdownPreviewKey, params?: Record<string, unknown>) => string
}

export function MarkdownAnnotations({
  children,
  resourceAddress,
  absolutePath,
  sourceText,
  t,
}: MarkdownAnnotationsProps): ReactNode {
  const labels: MarkdownAnnotationsLabels = {
    commentAdd: t('comment.add'),
    commentSave: t('comment.save'),
    commentCancel: t('comment.cancel'),
    commentPlaceholder: t('comment.placeholder'),
    commentDelete: t('comment.delete'),
    commentEdit: t('comment.edit'),
    commentBadge: t('comment.badge'),
    commentBadgeCount: count => t('comment.badgeCount', { n: count }),
    commentQuoted: t('comment.quoted'),
    commentInserted: t('comment.inserted'),
    commentInsertAll: t('comment.insertAll'),
    commentInsertAllTitle: t('comment.insertAllTitle'),
    selectionComment: t('selection.comment'),
    selectionQuote: t('selection.quote'),
    shortcutComment: t('comment.shortcutComment'),
    shortcutQuote: t('comment.shortcutQuote'),
  }

  return (
    <BaseMarkdownAnnotations
      resourceAddress={resourceAddress}
      absolutePath={absolutePath}
      sourceText={sourceText}
      labels={labels}
    >
      {children}
    </BaseMarkdownAnnotations>
  )
}
