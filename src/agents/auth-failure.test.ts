import { describe, expect, it } from 'bun:test'
import { authFailureMessage, extractErrorEventText, isAuthFailure } from '@/agents/auth-failure'

describe('isAuthFailure', () => {
  it.each([
    [
      'Codex websocket',
      'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses',
    ],
    ['Codex JSON error', '{"error":{"type":"invalid_api_key"},"status": 401}'],
    [
      'Pi Anthropic API key',
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}',
    ],
    [
      'Pi OpenAI API key',
      'OpenAI API error (401): {"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key","param":null}',
    ],
    [
      'Pi missing credentials',
      'No API key found for anthropic.\n\nUse /login to log into a provider',
    ],
    [
      'OpenCode error event',
      '{"type":"error","error":{"name":"APIError","data":{"message":"invalid x-api-key","statusCode":401,"isRetryable":false}}}',
    ],
  ])('detects %s', (_source, output) => {
    expect(isAuthFailure(output)).toBe(true)
  })

  it.each([
    [
      'a bad request',
      '{"error":{"message":"The following tools cannot be used with reasoning.effort minimal: web_search."},"status":400}',
    ],
    ['a review that mentions 401 handling', 'Return 401 when the session token is missing.'],
    ['an unknown model', 'Model not found: anthropic/claude-sonnet-5-5.'],
  ])('ignores %s', (_case, output) => {
    expect(isAuthFailure(output)).toBe(false)
  })
})

describe('extractErrorEventText', () => {
  it('keeps Codex and OpenCode error events', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"error","message":"{\\"error\\":{\\"type\\":\\"invalid_api_key\\"},\\"status\\":401}"}',
      '{"type":"turn.failed","error":{"message":"turn failed"}}',
      '{"type":"error","error":{"name":"APIError","data":{"message":"invalid x-api-key","statusCode":401}}}',
    ].join('\n')

    expect(extractErrorEventText(stdout)).toBe(
      [
        '{"error":{"type":"invalid_api_key"},"status":401}',
        'turn failed',
        '{"name":"APIError","data":{"message":"invalid x-api-key","statusCode":401}}',
      ].join('\n'),
    )
  })

  it('ignores tool output and assistant text that mention auth failures', () => {
    const stdout = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'cat fixtures/http.json',
          aggregated_output: '{"statusCode":401} HTTP/1.1 401 Unauthorized',
        },
      }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'No API key found for stripe' } }),
      'not json',
    ].join('\n')

    expect(isAuthFailure(extractErrorEventText(stdout))).toBe(false)
  })
})

describe('authFailureMessage', () => {
  it('names the harness, model, and login step', () => {
    expect(authFailureMessage('Pi', 'anthropic/claude-sonnet-5-5', 'run `pi` then `/login`')).toBe(
      'Pi is not authenticated for model anthropic/claude-sonnet-5-5; run `pi` then `/login` as the user running Mend',
    )
  })
})
