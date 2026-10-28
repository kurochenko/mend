import { createHmac } from 'node:crypto'
import type { GitLabProjectConfig } from '@/config'
import { constantTimeEquals } from '@/lib/constant-time'

const SIGNATURE_TOLERANCE_SECONDS = 300

export type WebhookAuthFailure =
  | 'missing_signature_headers'
  | 'invalid_timestamp'
  | 'signature_mismatch'
  | 'missing_token'
  | 'token_mismatch'

type HeaderReader = (name: string) => string | undefined

interface GitlabSignatureInput {
  signingKey: Buffer
  messageId: string | undefined
  timestamp: string | undefined
  signatures: string | undefined
  rawBody: string
  nowSeconds: number
}

export const verifyGitlabSignature = ({
  signingKey,
  messageId,
  timestamp,
  signatures,
  rawBody,
  nowSeconds,
}: GitlabSignatureInput): WebhookAuthFailure | null => {
  if (!messageId || !timestamp || !signatures) {
    return 'missing_signature_headers'
  }

  const timestampSeconds = Number(timestamp)
  if (
    !Number.isInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS
  ) {
    return 'invalid_timestamp'
  }

  const digest = createHmac('sha256', signingKey)
    .update(`${messageId}.${timestamp}.${rawBody}`)
    .digest('base64')
  const expected = `v1,${digest}`
  const matches = signatures
    .split(' ')
    .some((signature) => signature !== '' && constantTimeEquals(signature, expected))
  return matches ? null : 'signature_mismatch'
}

export const findGitlabWebhookAuthFailure = (
  project: GitLabProjectConfig,
  header: HeaderReader,
  rawBody: string,
): WebhookAuthFailure | null => {
  if (project.webhook_signing_token) {
    return verifyGitlabSignature({
      signingKey: project.webhook_signing_token,
      messageId: header('webhook-id'),
      timestamp: header('webhook-timestamp'),
      signatures: header('webhook-signature'),
      rawBody,
      nowSeconds: Math.floor(Date.now() / 1000),
    })
  }

  const token = header('X-Gitlab-Token')
  if (token === undefined || project.webhook_secret === undefined) {
    return 'missing_token'
  }
  return constantTimeEquals(token, project.webhook_secret) ? null : 'token_mismatch'
}

export const verifyGithubSignature = (
  secret: string,
  rawBody: string,
  signature: string | undefined,
): WebhookAuthFailure | null => {
  if (!signature?.startsWith('sha256=')) {
    return 'missing_signature_headers'
  }

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  return constantTimeEquals(signature, expected) ? null : 'signature_mismatch'
}
