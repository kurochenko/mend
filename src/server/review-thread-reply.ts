import { resolve } from 'node:path'
import type { ProjectConfig } from '@/config'
import { invokePiReview } from '@/agents/pi-harness'
import { createWorktree, ensureClone, removeWorktree } from '@/integrations/repo'
import { toErrorMessage } from '@/lib/errors'

const REPLY_TIMEOUT_MS = 120_000
const REPLY_SESSION_DIR = resolve('sessions', 'thread-replies')

interface ThreadMessage {
  author: string
  body: string
}

export interface GenerateThreadReplyParams {
  project: ProjectConfig
  mrIid: number
  requestId: string
  sourceBranch: string
  commitSha: string | null
  filePath: string | null
  line: number | null
  originalFinding: string
  threadMessages: ThreadMessage[]
  userQuestion: string
}

const buildReplyWorktreeSuffix = (requestId: string): string =>
  `reply-${requestId.replace(/[^a-zA-Z0-9_-]/g, '-')}`

const SYSTEM_INSTRUCTIONS = [
  'You are a code reviewer responding to a follow-up question or comment on a review thread.',
  '',
  'Your task:',
  '- Read the original review finding, the full conversation thread, and the latest message.',
  '- Use the coding tools to read the relevant source code and explore the codebase as needed.',
  '- Answer the specific question or address the specific comment. Do NOT repeat or paraphrase the original finding.',
  '- If the developer is pushing back with a valid technical point, acknowledge it honestly.',
  '- If you need to revise your original assessment after reading the code, say so clearly.',
  '',
  'Guidelines:',
  '- Be concise and direct. This is a GitLab thread reply, not an essay.',
  '- Reference specific code when explaining your reasoning.',
  '- If you are uncertain, say so rather than guessing.',
  '- Do not use markdown headers. Use plain text with inline code formatting where helpful.',
  '- Output ONLY the reply text. No JSON, no wrappers, no preamble.',
].join('\n')

export const buildThreadReplyPrompt = (params: {
  filePath: string | null
  line: number | null
  originalFinding: string
  threadMessages: ThreadMessage[]
  userQuestion: string
}): string => {
  const sections: string[] = []

  if (params.filePath) {
    const location = params.line ? `${params.filePath}:${params.line}` : params.filePath
    sections.push(`File under discussion: ${location}`)
    sections.push('')
  }

  sections.push('--- ORIGINAL REVIEW FINDING ---')
  sections.push(params.originalFinding)
  sections.push('--- END ORIGINAL REVIEW FINDING ---')
  sections.push('')

  if (params.threadMessages.length > 0) {
    sections.push('--- CONVERSATION THREAD ---')
    for (const message of params.threadMessages) {
      sections.push(`[${message.author}]:`)
      sections.push(message.body)
      sections.push('')
    }
    sections.push('--- END CONVERSATION THREAD ---')
    sections.push('')
  }

  sections.push('--- LATEST MESSAGE (respond to this) ---')
  sections.push(params.userQuestion)
  sections.push('--- END LATEST MESSAGE ---')
  sections.push('')
  sections.push('Read the relevant code and respond to the message above.')
  if (params.filePath) {
    sections.push(`Start by reading ${params.filePath} to understand the context.`)
  }

  return sections.join('\n')
}

export const generateThreadReply = async (params: GenerateThreadReplyParams): Promise<string> => {
  const { project, mrIid } = params
  const pathSuffix = buildReplyWorktreeSuffix(params.requestId)

  await ensureClone(project)

  let worktreePath: string
  try {
    worktreePath = await createWorktree(
      project,
      mrIid,
      params.sourceBranch,
      params.commitSha ?? undefined,
      { skipFetch: true, pathSuffix },
    )
  } catch {
    worktreePath = await createWorktree(
      project,
      mrIid,
      params.sourceBranch,
      params.commitSha ?? undefined,
      { pathSuffix },
    )
  }

  try {
    const sessionDir = resolve(
      REPLY_SESSION_DIR,
      project.key,
      `mr-${mrIid}`,
      params.requestId,
      `${Date.now()}`,
    )

    const prompt = buildThreadReplyPrompt({
      filePath: params.filePath,
      line: params.line,
      originalFinding: params.originalFinding,
      threadMessages: params.threadMessages,
      userQuestion: params.userQuestion,
    })

    const result = await invokePiReview({
      cwd: worktreePath,
      sessionDir,
      model: project.review.llm.model,
      thinkingLevel: project.review.llm.thinking_level,
      instructions: SYSTEM_INSTRUCTIONS,
      prompt,
      timeoutMs: REPLY_TIMEOUT_MS,
      toolMode: 'full',
    })

    if (!result.success) {
      throw new Error(`Thread reply LLM call failed: ${result.error}`)
    }

    const reply = result.output.trim()
    if (!reply) {
      throw new Error('Thread reply LLM returned empty output')
    }

    return reply
  } catch (error) {
    console.error(`[thread-reply] failed for ${project.key} MR !${mrIid}: ${toErrorMessage(error)}`)
    throw error
  } finally {
    await removeWorktree(project, mrIid, { pathSuffix })
  }
}
