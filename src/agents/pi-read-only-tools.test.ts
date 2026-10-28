import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createReadOnlyTools } from '@/agents/pi-read-only-tools'

let tmp: string
let root: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mend-pi-tools-'))
  root = join(tmp, 'worktree')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(tmp, 'secret.env'), 'TOKEN=leak\n')
  symlinkSync(join(tmp, 'secret.env'), join(root, 'linked.env'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const tool = (name: string): ToolDefinition => {
  const definition = createReadOnlyTools(root).find((candidate) => candidate.name === name)
  if (!definition) {
    throw new Error(`missing tool ${name}`)
  }
  return definition
}

const run = (name: string, params: Record<string, unknown>) =>
  tool(name).execute('call', params, undefined, undefined, { cwd: root } as never)

const textOf = (result: Awaited<ReturnType<ToolDefinition['execute']>>): string =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')

describe('createReadOnlyTools', () => {
  it('exposes only read, grep, find and ls', () => {
    expect(createReadOnlyTools(root).map((definition) => definition.name)).toEqual([
      'read',
      'grep',
      'find',
      'ls',
    ])
  })

  it('reads files inside the worktree', async () => {
    expect(textOf(await run('read', { path: 'src/a.ts' }))).toContain('export const a = 1')
  })

  it('refuses relative, absolute and home paths outside the worktree', async () => {
    await expect(run('read', { path: '../secret.env' })).rejects.toThrow(
      'outside the review worktree',
    )
    await expect(run('read', { path: join(tmp, 'secret.env') })).rejects.toThrow(
      'outside the review worktree',
    )
    await expect(run('read', { path: '~/.ssh/id_rsa' })).rejects.toThrow(
      'outside the review worktree',
    )
    await expect(run('ls', { path: '..' })).rejects.toThrow('outside the review worktree')
    await expect(run('grep', { pattern: 'TOKEN', path: tmp })).rejects.toThrow(
      'outside the review worktree',
    )
    await expect(run('find', { pattern: '*.env', path: '/' })).rejects.toThrow(
      'outside the review worktree',
    )
  })

  it('refuses file URLs and other URL schemes that the tools would resolve outside the worktree', async () => {
    for (const name of ['read', 'grep', 'find', 'ls']) {
      for (const path of [`file://${tmp}`, `@file://${tmp}`, 'file:///etc', 'FILE:///etc']) {
        const params = name === 'read' || name === 'ls' ? { path } : { pattern: 'TOKEN', path }
        await expect(run(name, params)).rejects.toThrow('outside the review worktree')
      }
    }
  })

  it('refuses symlinked directories outside the worktree for listing and search', async () => {
    symlinkSync(tmp, join(root, 'escape'))
    await expect(run('ls', { path: 'escape' })).rejects.toThrow('outside the review worktree')
    await expect(run('grep', { pattern: 'TOKEN', path: 'escape' })).rejects.toThrow(
      'outside the review worktree',
    )
  })

  it('refuses symlinks that point outside the worktree', async () => {
    await expect(run('read', { path: 'linked.env' })).rejects.toThrow('outside the review worktree')
  })
})
