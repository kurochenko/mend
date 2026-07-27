import type { GitHubProjectConfig } from '@/config'
import {
  createPrIssueComment,
  getPrIssueComment,
  listPrIssueComments,
} from '@/integrations/github/comments'
import { githubGraphql } from '@/integrations/github/graphql'
import { splitRepo } from '@/integrations/github/transport'
import type {
  ProviderNote,
  ProviderThread,
  ProviderThreadMessage,
  ThreadPosition,
} from '@/integrations/provider/types'

interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: GitHubReviewThread[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    }
  }
}

interface GitHubReviewThread {
  id: string
  isResolved: boolean
  comments: {
    nodes: GitHubReviewThreadComment[]
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}

interface GitHubReviewThreadComment {
  id: string
  databaseId: number | null
  body: string
  author: { login: string; databaseId?: number | null } | null
  createdAt?: string
  updatedAt?: string
  url?: string
  path?: string | null
  line?: number | null
  originalLine?: number | null
  startLine?: number | null
  diffSide?: string | null
}

interface ReviewThreadReplyResponse {
  addPullRequestReviewThreadReply: {
    comment: GitHubReviewThreadComment
  }
}

interface ReviewThreadCommentsResponse {
  node: {
    comments: GitHubReviewThread['comments']
  } | null
}

const reviewThreadCommentFields = `
  id
  databaseId
  body
  author {
    login
    ... on User {
      databaseId
    }
  }
  createdAt
  updatedAt
  url
  path
  line
  originalLine
  startLine
  diffSide
`

const listThreadsQuery = `
  query MendReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                ${reviewThreadCommentFields}
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`

const threadCommentsQuery = `
  query MendReviewThreadComments($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          nodes {
            ${reviewThreadCommentFields}
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`

const replyMutation = `
  mutation MendReplyToReviewThread($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment {
        ${reviewThreadCommentFields}
      }
    }
  }
`

const resolveMutation = `
  mutation MendResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
      }
    }
  }
`

const mapPosition = (comment: GitHubReviewThreadComment): ThreadPosition | null => {
  const path = comment.path ?? null
  const line = comment.line ?? comment.originalLine ?? null
  if (path === null && line === null) {
    return null
  }

  const onOldSide = comment.diffSide === 'LEFT'
  return {
    path,
    oldPath: path,
    line: onOldSide ? null : line,
    oldLine: onOldSide ? line : null,
  }
}

const mapReviewThreadMessage = (
  comment: GitHubReviewThreadComment,
  resolved: boolean,
): ProviderThreadMessage => ({
  id: comment.databaseId === null ? comment.id : `${comment.databaseId}`,
  body: comment.body,
  author: {
    id: comment.author?.databaseId ?? 0,
    username: comment.author?.login ?? 'unknown',
    raw: comment.author,
  },
  resolvable: true,
  resolved,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  url: comment.url,
  position: mapPosition(comment),
  raw: comment,
})

const mapReviewThread = (
  thread: GitHubReviewThread,
  comments: GitHubReviewThreadComment[],
): ProviderThread => ({
  id: thread.id,
  isThread: true,
  messages: comments.map((comment) => mapReviewThreadMessage(comment, thread.isResolved)),
  raw: thread,
})

const fetchAllThreadComments = async (
  project: GitHubProjectConfig,
  threadId: string,
  firstPage: GitHubReviewThread['comments'],
): Promise<GitHubReviewThreadComment[]> => {
  const comments = [...firstPage.nodes]
  let pageInfo = firstPage.pageInfo

  while (pageInfo.hasNextPage) {
    const data = await githubGraphql<ReviewThreadCommentsResponse>(project, threadCommentsQuery, {
      threadId,
      cursor: pageInfo.endCursor,
    })
    const page = data.node?.comments
    if (!page) {
      break
    }
    comments.push(...page.nodes)
    pageInfo = page.pageInfo
  }

  return comments
}

const mapIssueCommentThread = (note: ProviderNote): ProviderThread => ({
  id: `note_${note.id}`,
  isThread: false,
  messages: [
    {
      id: `${note.id}`,
      body: note.body,
      author: {
        id: note.author?.id ?? 0,
        username: note.author?.username ?? 'unknown',
        raw: note.author,
      },
      resolvable: false,
      position: null,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      raw: note,
    },
  ],
  raw: note,
})

export const listThreads = async (
  project: GitHubProjectConfig,
  prNumber: number,
): Promise<ProviderThread[]> => {
  const { owner, name } = splitRepo(project.repo)
  const reviewThreads: ProviderThread[] = []
  let cursor: string | null = null

  for (;;) {
    const data: ReviewThreadsResponse = await githubGraphql(project, listThreadsQuery, {
      owner,
      name,
      number: prNumber,
      cursor,
    })
    const page: ReviewThreadsResponse['repository']['pullRequest']['reviewThreads'] =
      data.repository.pullRequest.reviewThreads
    for (const thread of page.nodes) {
      const comments = await fetchAllThreadComments(project, thread.id, thread.comments)
      reviewThreads.push(mapReviewThread(thread, comments))
    }
    if (!page.pageInfo.hasNextPage) {
      break
    }
    cursor = page.pageInfo.endCursor
  }

  const issueCommentThreads = (await listPrIssueComments(project, prNumber)).map(
    mapIssueCommentThread,
  )
  return [...reviewThreads, ...issueCommentThreads]
}

export const getThread = async (
  project: GitHubProjectConfig,
  prNumber: number,
  threadId: string,
): Promise<ProviderThread> => {
  if (threadId.startsWith('note_')) {
    const noteId = Number(threadId.slice('note_'.length))
    if (!Number.isInteger(noteId)) {
      throw new Error(`Invalid GitHub note thread id: ${threadId}`)
    }
    return mapIssueCommentThread(await getPrIssueComment(project, noteId))
  }

  const thread = (await listThreads(project, prNumber)).find(
    (candidate) => candidate.id === threadId,
  )
  if (!thread) {
    throw new Error(`GitHub review thread not found: ${threadId}`)
  }
  return thread
}

export const createThread = async (
  project: GitHubProjectConfig,
  prNumber: number,
  body: string,
): Promise<ProviderThread> =>
  mapIssueCommentThread(await createPrIssueComment(project, prNumber, body))

export const replyToThread = async (
  project: GitHubProjectConfig,
  prNumber: number,
  threadId: string,
  body: string,
): Promise<ProviderThreadMessage> => {
  if (threadId.startsWith('note_')) {
    const note = await createPrIssueComment(project, prNumber, body)
    return mapIssueCommentThread(note).messages[0]!
  }

  const data = await githubGraphql<ReviewThreadReplyResponse>(project, replyMutation, {
    threadId,
    body,
  })
  return mapReviewThreadMessage(data.addPullRequestReviewThreadReply.comment, false)
}

export const resolveThread = async (
  project: GitHubProjectConfig,
  threadId: string,
): Promise<void> => {
  if (threadId.startsWith('note_')) {
    console.warn(`GitHub general PR comment thread ${threadId} cannot be resolved`)
    return
  }

  await githubGraphql(project, resolveMutation, { threadId })
}
