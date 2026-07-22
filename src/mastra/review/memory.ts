import type { ReviewMemoryEntryRecord } from '@/db/review-memory'

const truncateSourceBody = (sourceBody: string): string => {
  const normalized = sourceBody.trim().replace(/\s+/g, ' ')
  if (normalized.length <= 200) {
    return normalized
  }

  return `${normalized.slice(0, 197)}...`
}

const readSourceBody = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== 'object' || !('sourceBody' in metadata)) {
    return null
  }

  const sourceBody = metadata.sourceBody
  return typeof sourceBody === 'string' && sourceBody.trim() ? sourceBody : null
}

const formatMemoryInstruction = (memory: ReviewMemoryEntryRecord): string => {
  const location =
    memory.matchPath && memory.matchLine ? `[${memory.matchPath}:${memory.matchLine}] ` : ''
  const sourceBody = readSourceBody(memory.metadata)
  const sourceExcerpt = sourceBody ? ` — original finding: "${truncateSourceBody(sourceBody)}"` : ''

  return `- ${location}${memory.instruction}${sourceExcerpt}`
}

export const buildReviewMemoryPromptSections = (memories: ReviewMemoryEntryRecord[]): string[] => {
  if (memories.length === 0) {
    return []
  }

  const mrMemories = memories.filter((memory) => memory.scope === 'mr')
  const projectMemories = memories.filter((memory) => memory.scope === 'project')
  const sections: string[] = []

  if (mrMemories.length > 0) {
    sections.push(
      [
        '## Active MR Decisions',
        '',
        'If a candidate finding matches an entry below (same file and line, or clearly the same underlying concern), omit it entirely.',
        ...mrMemories.map(formatMemoryInstruction),
      ].join('\n'),
    )
  }

  if (projectMemories.length > 0) {
    sections.push(
      [
        '## Project Review Memory',
        '',
        'If a candidate finding matches an entry below (same file and line, or clearly the same underlying concern), omit it entirely.',
        ...projectMemories.map(formatMemoryInstruction),
      ].join('\n'),
    )
  }

  return sections
}
