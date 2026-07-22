import { describe, expect, it } from 'bun:test'
import { extractJson } from '@/lib/json'

describe('extractJson', () => {
  it('parses direct JSON payload', () => {
    const parsed = extractJson('{"a":1,"b":"ok"}') as Record<string, unknown>
    expect(parsed.a).toBe(1)
    expect(parsed.b).toBe('ok')
  })

  it('parses JSON fence when non-json fence appears first', () => {
    const payload = `\n\`\`\`bash\necho test\n\`\`\`\n\n\`\`\`json\n{"assessment":"approve"}\n\`\`\``
    const parsed = extractJson(payload) as Record<string, unknown>
    expect(parsed.assessment).toBe('approve')
  })

  it('parses the last valid balanced JSON object in mixed text', () => {
    const payload = `prefix {"ignore":true} middle {"assessment":"request_changes","count":2} suffix`
    const parsed = extractJson(payload) as Record<string, unknown>
    expect(parsed.assessment).toBe('request_changes')
    expect(parsed.count).toBe(2)
  })

  it('parses fenced JSON with nested code fences inside string content', () => {
    const payload = [
      '```json',
      '{',
      '  "summary": "Example with nested fence\\n\\n```makefile\\nup: infra-up\\n\\t@$(MAKE) services-up\\n```",',
      '  "assessment": "approve"',
      '}',
      '```',
    ].join('\n')

    const parsed = extractJson(payload) as Record<string, unknown>
    expect(parsed.assessment).toBe('approve')
    expect(parsed.summary).toBeString()
  })
})
