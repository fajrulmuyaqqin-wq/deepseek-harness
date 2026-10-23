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
  'comment.add': 'コメントを追加',
  'comment.save': '保存',
  'comment.cancel': 'キャンセル',
  'comment.placeholder': 'コメントを残す',
  'comment.delete': '削除',
  'comment.edit': 'コメントを編集',
  'comment.badge': 'コメント',
  'comment.badgeCount': '{n} 件のコメント',
  'comment.quoted': '入力欄に引用しました',
  'comment.inserted': '入力欄にコメントを追加しました',
  'comment.insertAll': 'チャットに挿入',
  'comment.insertAllTitle': 'すべてのコメントを入力欄に挿入',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': 'コメント',
  'selection.quote': '引用',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas a pie de página',
  'comment.add': 'Agregar comentario',
  'comment.save': 'Guardar',
  'comment.cancel': 'Cancelar',
  'comment.placeholder': 'Dejar un comentario',
  'comment.delete': 'Eliminar',
  'comment.edit': 'Editar comentario',
  'comment.badge': 'Comentario',
  'comment.badgeCount': '{n} comentarios',
  'comment.quoted': 'Citado en el compositor',
  'comment.inserted': 'Comentario agregado al compositor',
  'comment.insertAll': 'Insertar en el chat',
  'comment.insertAllTitle': 'Insertar todos los comentarios en el compositor',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': 'Comentario',
  'selection.quote': 'Citar',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copier',
  'code.copied': 'Copié',
  'footnotes': 'Notes de bas de page',
  'comment.add': 'Ajouter un commentaire',
  'comment.save': 'Enregistrer',
  'comment.cancel': 'Annuler',
  'comment.placeholder': 'Laisser un commentaire',
  'comment.delete': 'Supprimer',
  'comment.edit': 'Modifier le commentaire',
  'comment.badge': 'Commentaire',
  'comment.badgeCount': '{n} commentaires',
  'comment.quoted': 'Cité dans le compositeur',
  'comment.inserted': 'Commentaire ajouté au compositeur',
  'comment.insertAll': 'Insérer dans le chat',
  'comment.insertAllTitle': 'Insérer tous les commentaires dans le compositeur',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': 'Commentaire',
  'selection.quote': 'Citer',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'viewer.label': 'Markdown',
  'code.copy': 'Kopieren',
  'code.copied': 'Kopiert',
  'footnotes': 'Fußnoten',
  'comment.add': 'Kommentar hinzufügen',
  'comment.save': 'Speichern',
  'comment.cancel': 'Abbrechen',
  'comment.placeholder': 'Hinterlasse einen Kommentar',
  'comment.delete': 'Löschen',
  'comment.edit': 'Kommentar bearbeiten',
  'comment.badge': 'Kommentar',
  'comment.badgeCount': '{n} Kommentare',
  'comment.quoted': 'Im Composer zitiert',
  'comment.inserted': 'Kommentar zum Composer hinzugefügt',
  'comment.insertAll': 'In Chat einfügen',
  'comment.insertAllTitle': 'Alle Kommentare in den Composer einfügen',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': 'Kommentar',
  'selection.quote': 'Zitieren',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'viewer.label': 'Markdown',
  'code.copy': 'Копировать',
  'code.copied': 'Скопировано',
  'footnotes': 'Сноски',
  'comment.add': 'Добавить комментарий',
  'comment.save': 'Сохранить',
  'comment.cancel': 'Отмена',
  'comment.placeholder': 'Оставить комментарий',
  'comment.delete': 'Удалить',
  'comment.edit': 'Редактировать комментарий',
  'comment.badge': 'Комментарий',
  'comment.badgeCount': '{n} комментариев',
  'comment.quoted': 'Процитировано в редакторе',
  'comment.inserted': 'Комментарий добавлен в редактор',
  'comment.insertAll': 'Вставить в чат',
  'comment.insertAllTitle': 'Вставить все комментарии в редактор',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': 'Комментарий',
  'selection.quote': 'Цитата',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas de rodapé',
  'comment.add': 'Adicionar comentário',
  'comment.save': 'Salvar',
  'comment.cancel': 'Cancelar',
  'comment.placeholder': 'Deixe um comentário',
  'comment.delete': 'Excluir',
  'comment.edit': 'Editar comentário',
  'comment.badge': 'Comentário',
  'comment.badgeCount': '{n} comentários',
  'comment.quoted': 'Citado no compositor',
  'comment.inserted': 'Comentário adicionado ao compositor',
  'comment.insertAll': 'Inserir no chat',
  'comment.insertAllTitle': 'Inserir todos os comentários no compositor',
  'comment.shortcutComment': 'Ctrl+Alt+M',
  'comment.shortcutQuote': 'Ctrl+L',
  'selection.comment': 'Comentário',
  'selection.quote': 'Citar',
} satisfies Record<keyof typeof en, string>
