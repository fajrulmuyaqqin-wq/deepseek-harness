/**
 * Display projection of reference forms in sent user text (bubble and queue
 * rows). The logged model text remains the single truth; this is presentation
 * only. Inline references follow the consumer's wrapping policy and keep long
 * labels within its width. Four decoration sources, by precedence: the wire session form
 * `@[label](dsh-session:...)` folds to its label; exact session labels
 * supplied by an adjacent recall decorate their bare `@label` mention; plain
 * `@name` word-boundary tokens decorate by shape alone; and a plain `/name`
 * token decorates only when the caller names it — a skill the host actually
 * loaded for that message (ui-chat reads the step's `skill-invocation`
 * injections) or the command a command-input bubble echoes — so `/123` or a
 * stray `/word` stays plain text. A `/name` token is whitespace-bounded like
 * the host skill gesture (`dsh-tool-skill`): it ends at whitespace or the
 * text end, so slash paths (`/nfs-hg/xxx`, `/plan.md`) and punctuation-glued
 * tokens (`/plan。`) stay plain even for a loaded name.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { ReferenceIconRegular } from './ReferenceIcon.tsx'
import css from './user-text.module.css'
import markdownCss from './markdown/MarkdownText.module.css'

/** Wire form of artifact comments: [Artifact comment on [label](url)]: > snippet \n body.
 * The URL is optional and may appear on the same line or the next line. */
const ARTIFACT_COMMENT_RE = new RegExp(
  '(?:^|\\n)\\[Artifact comment on (?:'
    + '\\[([^\\]\\n]+)\\](?:[ \\t]*(?:\\n[ \\t]*)?\\(([^\\n]*(?:\\)[^\\n]*)*)\\))?'
    + '|((?:file://|dsh-resource://|/)[^\\n\\]]+)'
    + ')\\]:?[ \\t]*(?:\\n((?:> [^\\n]*(?:\\n|$))*))?',
  'gu',
)

/** Wire form of artifact quotes: > [label](url) \n > snippet.
 * The URL is optional and may appear on the same line or the next line. */
const ARTIFACT_QUOTE_RE = new RegExp(
  '(?:^|\\n)> \\[(.+?)\\](?:[ \\t]*(?:\\n[ \\t]*)?\\(([^\\n]*(?:\\)[^\\n]*)*)\\))?[ \\t]*'
    + '((?:\\n>[ \\t]*[^\\n]*)*)',
  'gu',
)

/** The wire form a session chip serializes to; label is the display text. */
const SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu

/** Sentence punctuation a bare `@name` token may carry without being part of the reference. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？]+$/u

/** Parse file location URI into clean path and optional 1-based line number.
 * Returns `filePath: undefined` when `rawUrl` is absent or empty (e.g. conversation-turn quotes). */
function parseFileLocation(rawUrl: string | undefined): { filePath: string | undefined; line?: number | undefined } {
  if (rawUrl === undefined || rawUrl === '') return { filePath: undefined }
  let clean = rawUrl
  if (clean.startsWith('file://')) {
    clean = clean.slice(7)
  } else if (clean.startsWith('dsh-resource://file/')) {
    clean = clean.slice('dsh-resource://file/'.length)
  }
  const match = /#(?:L|line-)?(\d+)(?:-L?\d+)?$/iu.exec(clean)
  if (match) {
    const line = parseInt(match[1] as string, 10)
    const pathPart = clean.slice(0, match.index)
    return {
      filePath: decodeURIComponent(pathPart),
      line: Number.isFinite(line) ? line : undefined,
    }
  }
  return { filePath: decodeURIComponent(clean) }
}

interface DecorationRange {
  readonly start: number
  readonly end: number
  /** Matched source text (hover title). */
  readonly label: string
  readonly kind: 'session' | 'plain' | 'quote' | 'comment'
  /** Pre-resolved display text (wire folds); derived from label when absent. */
  readonly display?: string | undefined
  /** Decoded file path for quote or comment navigation. */
  readonly filePath?: string | undefined
  /** 1-based line number for opening the file. */
  readonly line?: number | undefined
  /** Quote snippet text. */
  readonly snippet?: string | undefined
}

/** Optional navigation supplied by consumers that can preview references. */
export interface UserTextReferences {
  /** Open a file path decoded from an `@` mention, quote, or comment. */
  openFile: (path: string, options?: { line?: number }) => void
  /** Open the source of a skill loaded for this message. */
  openSkill: (name: string) => void
}

/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @param slashNames - names a `/name` token may decorate as: the skills the
 * host loaded for this message, or the command a command bubble echoes
 * (unsent queue rows pass none).
 * @param slashKind - the chip kind those tokens render as.
 * @param references - optional file and skill preview actions; session and command tokens stay labels.
 * @returns inline nodes covering the whole text.
 */
export function projectUserText(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[] = [],
  slashKind: 'skill' | 'command' = 'skill',
  references?: UserTextReferences,
): ReactNode {
  const ranges: DecorationRange[] = []
  ARTIFACT_COMMENT_RE.lastIndex = 0
  let commentMatch: RegExpExecArray | null
  while ((commentMatch = ARTIFACT_COMMENT_RE.exec(text)) !== null) {
    const offset = commentMatch[0].startsWith('\n') ? 1 : 0
    const start = commentMatch.index + offset
    const end = commentMatch.index + commentMatch[0].length
    const rawLabel = commentMatch[1]
    const rawUrl = commentMatch[2] ?? commentMatch[3]
    const rawSnippet = commentMatch[4]
    const { filePath, line } = parseFileLocation(rawUrl)
    const label = rawLabel ?? (filePath !== undefined
      ? (filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? filePath)
      : rawUrl ?? '')
    const cleanSnippet = rawSnippet ? rawSnippet.replace(/^> ?/gmu, '').trim() : undefined
    ranges.push({
      start,
      end,
      label,
      kind: 'comment',
      filePath,
      line,
      snippet: cleanSnippet,
    })
  }
  ARTIFACT_QUOTE_RE.lastIndex = 0
  let quoteMatch: RegExpExecArray | null
  while ((quoteMatch = ARTIFACT_QUOTE_RE.exec(text)) !== null) {
    const offset = quoteMatch[0].startsWith('\n') ? 1 : 0
    const start = quoteMatch.index + offset
    const end = quoteMatch.index + quoteMatch[0].length
    const rawLabel = quoteMatch[1] as string
    const rawUrl = quoteMatch[2] as string | undefined
    const rawSnippet = quoteMatch[3]
    const { filePath, line } = parseFileLocation(rawUrl)
    const cleanSnippet = rawSnippet ? rawSnippet.replace(/^> ?/gmu, '').trim() : undefined
    ranges.push({
      start,
      end,
      label: rawLabel,
      kind: 'quote',
      filePath,
      line,
      snippet: cleanSnippet,
    })
  }
  SESSION_WIRE_RE.lastIndex = 0
  let wire: RegExpExecArray | null
  while ((wire = SESSION_WIRE_RE.exec(text)) !== null) {
    ranges.push({
      start: wire.index,
      end: wire.index + wire[0].length,
      label: wire[0],
      kind: 'session',
      display: wire[1], // non-optional capture in SESSION_WIRE_RE
    })
  }
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  // A `/` token ends at whitespace or the text end like the host skill
  // gesture; only `@` tokens shed sentence punctuation below.
  const re = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1] as string).length // (^|\s) captures '' at line start
    const rawLabel = m[2] as string // non-optional alternation capture
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(TRAILING_PUNCTUATION_RE, '')
    if (label.length <= 1) continue
    if (label.startsWith('/') && !slashNames.includes(label.slice(1))) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  const rankOf = (range: DecorationRange): number => {
    switch (range.kind) {
      case 'comment': return 0
      case 'quote': return 1
      case 'session': return 2
      case 'plain': return 3
    }
  }
  ranges.sort((a, b) => a.start - b.start || rankOf(a) - rankOf(b) || b.end - a.end)
  const parts: ReactNode[] = []
  let cursor = 0
  const pushPlain = (from: number, to: number): void => {
    parts.push(<span key={`t${from}`} className={css.plainRun}>{text.slice(from, to)}</span>)
  }
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) pushPlain(cursor, tokenStart)

    if (kind === 'comment') {
      const open = (references === undefined || range.filePath === undefined) ? undefined
        : () => { references.openFile(range.filePath as string, range.line !== undefined ? { line: range.line } : undefined) }
      const commentChipContents = (
        <>
          <ReferenceIconRegular kind="session" size={14} className={css.refIcon} />
          <span className={css.commentLabel}>{label}</span>
        </>
      )
      parts.push(open === undefined
        ? <span key={`c${tokenStart}`} className={clsx(css.refChip, css.commentChip)} data-ref-chip="comment" title={label}>
          {commentChipContents}
        </span>
        : <button
          key={`c${tokenStart}`}
          type="button"
          className={clsx(css.refChip, css.commentChip, markdownCss.fileMention)}
          data-ref-chip="comment"
          title={label}
          onClick={(event) => {
            if (event.detail > 1
              || (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)) return
            open()
          }}
        >
          {commentChipContents}
        </button>)

      if (range.snippet && range.snippet.length > 0) {
        const cleanSnippet = range.snippet.replace(/\s+/g, ' ').trim()
        const displaySnippet = cleanSnippet.length > 40 ? `${cleanSnippet.slice(0, 37)}...` : cleanSnippet
        const quoteContents = (
          <>
            <ReferenceIconRegular kind="session" size={14} className={css.refIcon} />
            <span className={css.quoteLabel}>{displaySnippet}</span>
          </>
        )
        const quoteTitle = `${label}\n${range.snippet}`
        parts.push(open === undefined
          ? <span key={`cq${tokenStart}`} className={clsx(css.refChip, css.quoteChip)} data-ref-chip="quote" title={quoteTitle}>
            {quoteContents}
          </span>
          : <button
            key={`cq${tokenStart}`}
            type="button"
            className={clsx(css.refChip, css.quoteChip, markdownCss.fileMention)}
            data-ref-chip="quote"
            title={quoteTitle}
            onClick={(event) => {
              if (event.detail > 1
                || (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)) return
              open()
            }}
          >
            {quoteContents}
          </button>)
      }
      if (end < text.length && !text.slice(end).startsWith('\n')) {
        parts.push('\n')
      }
      cursor = end
      continue
    }

    if (kind === 'quote') {
      const open = (references === undefined || range.filePath === undefined) ? undefined
        : () => { references.openFile(range.filePath as string, range.line !== undefined ? { line: range.line } : undefined) }
      const cleanSnippet = (range.snippet ?? '').replace(/\s+/g, ' ').trim()
      const displaySnippet = cleanSnippet.length > 0
        ? (cleanSnippet.length > 40 ? `${cleanSnippet.slice(0, 37)}...` : cleanSnippet)
        : label
      const quoteTitle = cleanSnippet.length > 0 ? `${label}\n${range.snippet}` : label
      const quoteContents = (
        <>
          <ReferenceIconRegular kind="session" size={14} className={css.refIcon} />
          <span className={css.quoteLabel}>{displaySnippet}</span>
        </>
      )
      parts.push(open === undefined
        ? <span key={`q${tokenStart}`} className={clsx(css.refChip, css.quoteChip)} data-ref-chip="quote" title={quoteTitle}>
          {quoteContents}
        </span>
        : <button
          key={`q${tokenStart}`}
          type="button"
          className={clsx(css.refChip, css.quoteChip, markdownCss.fileMention)}
          data-ref-chip="quote"
          title={quoteTitle}
          onClick={(event) => {
            if (event.detail > 1
              || (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)) return
            open()
          }}
        >
          {quoteContents}
        </button>)
      if (end < text.length && !text.slice(end).startsWith(' ') && !text.slice(end).startsWith('\n')) {
        parts.push(' ')
      }
      cursor = end
      continue
    }

    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.replace(/^@"|"$/gu, '').endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = range.display
      ?? (referenceKind === undefined
        ? label
        : referenceKind === 'session'
          ? label.slice(1)
          : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1))
    const contents = <>
      {referenceKind !== undefined && (
        <ReferenceIconRegular kind={referenceKind} size={16} className={css.refIcon} />
      )}
      {displayLabel}
    </>
    const open = references === undefined ? undefined
      : referenceKind === 'file'
        ? () => { references.openFile(label.slice(1).replace(/^"|"$/gu, '')) }
        : referenceKind === undefined && slashKind === 'skill'
          ? () => { references.openSkill(label.slice(1)) }
          : undefined
    const className = clsx(css.refChip, referenceKind === undefined && css.slashChip)
    parts.push(open === undefined
      ? <span key={tokenStart} className={className} data-ref-chip={referenceKind ?? slashKind} title={label}>
        {contents}
      </span>
      : <button
        key={tokenStart}
        type="button"
        className={clsx(className, markdownCss.fileMention)}
        data-ref-chip={referenceKind ?? slashKind}
        title={label}
        onClick={(event) => {
          if (event.detail > 1 || (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)) return
          open()
        }}
      >
        {contents}
      </button>)
    cursor = end
  }
  if (parts.length === 0) return <span className={css.plainRun}>{text}</span>
  if (cursor < text.length) pushPlain(cursor, text.length)
  return <>{parts}</>
}
