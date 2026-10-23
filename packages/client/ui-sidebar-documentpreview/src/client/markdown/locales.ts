/** Markdown implementation labels and primitive chrome. */
export const zh = {
  'viewer.label': 'Markdown',
  'code.copy': '复制',
  'code.copied': '已复制',
  'footnotes': '脚注',
  'comment.add': '添加评论',
  'comment.save': '保存',
  'comment.cancel': '取消',
  'comment.placeholder': '发表评论',
  'comment.delete': '删除',
  'comment.edit': '编辑评论',
  'comment.badge': '评论',
  'comment.badgeCount': '{n} 条评论',
  'comment.quoted': '已引用至输入框',
  'comment.inserted': '已添加评论至输入框',
  'comment.insertAll': '插入至聊天',
  'comment.insertAllTitle': '将所有评论插入至输入框',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': '评论',
  'selection.quote': '引用',
} satisfies Record<string, string>

/** Markdown namespace keys. */
export type MarkdownPreviewKey = keyof typeof zh

/** English labels, paired with the Chinese key set. */
export const en = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
  'comment.add': 'Add Comment',
  'comment.save': 'Save',
  'comment.cancel': 'Cancel',
  'comment.placeholder': 'Leave a comment',
  'comment.delete': 'Delete',
  'comment.edit': 'Edit Comment',
  'comment.badge': 'Comment',
  'comment.badgeCount': '{n} comments',
  'comment.quoted': 'Quoted to composer',
  'comment.inserted': 'Comment added to composer',
  'comment.insertAll': 'Insert to chat',
  'comment.insertAllTitle': 'Insert all comments into composer',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': 'Comment',
  'selection.quote': 'Quote',
} satisfies Record<MarkdownPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Markdown document renderer and its code/footnote controls. */
    documentMarkdown: MarkdownPreviewKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'viewer.label': 'Markdown',
  'code.copy': 'コピー',
  'code.copied': 'コピーしました',
  'footnotes': '脚注',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas a pie de página',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copier',
  'code.copied': 'Copié',
  'footnotes': 'Notes de bas de page',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'viewer.label': 'Markdown',
  'code.copy': 'Kopieren',
  'code.copied': 'Kopiert',
  'footnotes': 'Fußnoten',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'viewer.label': 'Markdown',
  'code.copy': 'Копировать',
  'code.copied': 'Скопировано',
  'footnotes': 'Сноски',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas de rodapé',
} satisfies Record<keyof typeof en, string>
