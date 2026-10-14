/**
 * Resolve file paths, line ranges, and directory links for markdown annotations and quotes.
 */

export interface ResolvedSourceLocation {
  /** Short file name, e.g. "plan.md" or "Roadmap" */
  fileName: string
  /** Clean path, e.g. "/var/home/fazdev/deepseek-harness/plan.md" */
  filePath: string
  /** Clickable file URI with line fragment, e.g. "file:///path/to/file.md#L12-L15" */
  fileUrl: string
  /** 1-based start line */
  startLine: number
  /** 1-based end line */
  endLine: number
  /** Formatted line label, e.g. "plan.md:L12" or "plan.md:L12-L15" */
  lineLabel: string
  /** Markdown link string, e.g. "[plan.md:L12-L15](file:///path/to/file.md#L12-L15)" */
  markdownLink: string
}

/**
 * Resolve exact line range and directory link for a commented or quoted snippet.
 * @param resourceAddress - The URI address of the resource
 * @param absolutePath - Optional absolute file path or title
 * @param sourceText - Complete markdown source text if available
 * @param targetSnippet - The text snippet being commented or quoted
 * @param blockIndex - 0-based fallback block index if snippet search fails
 * @returns The resolved source location
 */
export function resolveSourceLocation(
  resourceAddress: string,
  absolutePath: string | undefined,
  sourceText: string | undefined,
  targetSnippet: string,
  blockIndex = 0,
): ResolvedSourceLocation {
  let cleanPath = absolutePath && absolutePath.trim() ? absolutePath.trim() : resourceAddress
  if (cleanPath.startsWith('dsh-resource://file/')) {
    cleanPath = decodeURIComponent(cleanPath.replace('dsh-resource://file/', ''))
  }

  const parts = cleanPath.split('/')
  const rawFileName = parts[parts.length - 1] || cleanPath
  const fileName = rawFileName.replace(/^[#\s]+/, '').trim() || 'document.md'

  let startLine = 1
  let endLine = 1

  if (sourceText && targetSnippet) {
    const lines = sourceText.split('\n')
    const firstSnippetLine = targetSnippet.trim().split('\n')[0]?.trim() || ''

    if (firstSnippetLine.length > 0) {
      for (let i = 0; i < lines.length; i++) {
        const lineTrimmed = lines[i]?.trim() || ''
        if (lineTrimmed.length > 0 && (lineTrimmed.includes(firstSnippetLine) || firstSnippetLine.includes(lineTrimmed))) {
          startLine = i + 1
          const snippetLineCount = targetSnippet.trim().split('\n').length
          endLine = Math.min(lines.length, startLine + snippetLineCount - 1)
          break
        }
      }
    }
  } else {
    startLine = Math.max(1, (blockIndex + 1) * 2)
    endLine = startLine
  }

  const lineFragment = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`
  const lineLabel = `${fileName}:${lineFragment}`

  let fileUrl = cleanPath
  if (cleanPath.startsWith('/')) {
    fileUrl = `file://${cleanPath}#${lineFragment}`
  } else if (!cleanPath.includes('://')) {
    fileUrl = `file:///${cleanPath}#${lineFragment}`
  } else {
    fileUrl = `${cleanPath}#${lineFragment}`
  }

  const markdownLink = `[${lineLabel}](${fileUrl})`

  return {
    fileName,
    filePath: cleanPath,
    fileUrl,
    startLine,
    endLine,
    lineLabel,
    markdownLink,
  }
}
