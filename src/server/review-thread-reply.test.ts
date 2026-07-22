import { describe, expect, test } from 'bun:test'
import { buildThreadReplyPrompt } from '@/server/review-thread-reply'

describe('buildThreadReplyPrompt', () => {
  test('includes file path and line in location header', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: 'src/deploy.sh',
      line: 42,
      originalFinding: 'The rebase might fail silently.',
      threadMessages: [],
      userQuestion: 'Why is this a problem?',
    })

    expect(prompt).toContain('File under discussion: src/deploy.sh:42')
  })

  test('includes file path without line when line is null', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: 'src/deploy.sh',
      line: null,
      originalFinding: 'The rebase might fail silently.',
      threadMessages: [],
      userQuestion: 'Why is this a problem?',
    })

    expect(prompt).toContain('File under discussion: src/deploy.sh')
    expect(prompt).not.toContain('src/deploy.sh:')
  })

  test('wraps original finding in delimiters', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: null,
      line: null,
      originalFinding: 'Guard the rebase or re-clone on failure.',
      threadMessages: [],
      userQuestion: 'What should we do?',
    })

    expect(prompt).toContain('--- ORIGINAL REVIEW FINDING ---')
    expect(prompt).toContain('Guard the rebase or re-clone on failure.')
    expect(prompt).toContain('--- END ORIGINAL REVIEW FINDING ---')
  })

  test('wraps conversation thread in delimiters with author labels', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: 'src/app.ts',
      line: 10,
      originalFinding: 'Null check missing.',
      threadMessages: [
        { author: 'mend-bot', body: 'Null check missing.' },
        { author: 'developer', body: 'Is this really needed?' },
      ],
      userQuestion: 'Can you explain more?',
    })

    expect(prompt).toContain('--- CONVERSATION THREAD ---')
    expect(prompt).toContain('[mend-bot]:')
    expect(prompt).toContain('Null check missing.')
    expect(prompt).toContain('[developer]:')
    expect(prompt).toContain('Is this really needed?')
    expect(prompt).toContain('--- END CONVERSATION THREAD ---')
  })

  test('wraps user question in delimiters', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: null,
      line: null,
      originalFinding: 'Some finding.',
      threadMessages: [],
      userQuestion: 'Config files are environment-scoped. What should you suggest?',
    })

    expect(prompt).toContain('--- LATEST MESSAGE (respond to this) ---')
    expect(prompt).toContain('Config files are environment-scoped. What should you suggest?')
    expect(prompt).toContain('--- END LATEST MESSAGE ---')
  })

  test('omits conversation thread section when no messages', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: null,
      line: null,
      originalFinding: 'Some finding.',
      threadMessages: [],
      userQuestion: 'Why?',
    })

    expect(prompt).not.toContain('--- CONVERSATION THREAD ---')
  })

  test('suggests reading the file when filePath is provided', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: 'src/deploy.sh',
      line: 42,
      originalFinding: 'Issue here.',
      threadMessages: [],
      userQuestion: 'Why?',
    })

    expect(prompt).toContain('Start by reading src/deploy.sh')
  })

  test('omits file reading suggestion when no filePath', () => {
    const prompt = buildThreadReplyPrompt({
      filePath: null,
      line: null,
      originalFinding: 'Issue here.',
      threadMessages: [],
      userQuestion: 'Why?',
    })

    expect(prompt).not.toContain('Start by reading')
  })
})
