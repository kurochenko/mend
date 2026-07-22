import { describe, expect, test } from 'bun:test'
import { FixerOutputParseError, parseFixerOutput } from '@/mastra/fix/schema'

describe('parseFixerOutput', () => {
  test('parses valid fixer output from mixed text', () => {
    const output = parseFixerOutput(`done
{
  "version": "fixer-v1",
  "summary": "Fixed one issue",
  "fixedFindings": [{ "id": "accepted-1", "summary": "Added guard" }],
  "notFixedFindings": [{ "id": "accepted-2", "reason": "Needs product decision" }],
  "changedFiles": ["src/app.ts"],
  "checksRun": [{ "command": "bun test", "status": "passed", "summary": "ok" }],
  "errors": []
}`)

    expect(output.fixedFindings.map((finding) => finding.id)).toEqual(['accepted-1'])
    expect(output.notFixedFindings[0]?.reason).toBe('Needs product decision')
    expect(output.changedFiles).toEqual(['src/app.ts'])
  })

  test('rejects malformed fixer output with a clear error', () => {
    expect(() => parseFixerOutput('{"version":"wrong"}')).toThrow(FixerOutputParseError)
  })
})
