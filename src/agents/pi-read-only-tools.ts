import { constants, existsSync, realpathSync } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(canonicalPath(parent), basename(path))
  }
}

export const isInsideRoot = (root: string, absolutePath: string): boolean => {
  const relativePath = relative(canonicalPath(root), canonicalPath(absolutePath))
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

const assertInsideRoot = (root: string, absolutePath: string): void => {
  if (!isInsideRoot(root, absolutePath)) {
    throw new Error(`Access denied: ${absolutePath} is outside the review worktree`)
  }
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

const resolveToolPath = (root: string, rawPath: unknown): string => {
  const path =
    typeof rawPath === 'string' && rawPath.length > 0
      ? rawPath.replace(UNICODE_SPACES, ' ').replace(/^@/, '')
      : '.'
  if (path.startsWith('~') || URL_SCHEME.test(path)) {
    throw new Error(`Access denied: ${path} is outside the review worktree`)
  }
  return resolve(root, path)
}

const guarded =
  <T>(root: string, operation: (path: string) => Promise<T>) =>
  async (path: string): Promise<T> => {
    assertInsideRoot(root, path)
    return await operation(path)
  }

const confineToRoot = (root: string, definition: ToolDefinition): ToolDefinition => ({
  ...definition,
  execute: async (...args: Parameters<ToolDefinition['execute']>) => {
    const [, params] = args
    const rawPath =
      typeof params === 'object' && params !== null && 'path' in params ? params.path : undefined
    assertInsideRoot(root, resolveToolPath(root, rawPath))
    return await definition.execute(...args)
  },
})

export const createReadOnlyTools = (root: string): ToolDefinition[] => {
  const read = createReadToolDefinition(root, {
    operations: {
      readFile: guarded(root, async (path) => await readFile(path)),
      access: guarded(root, async (path) => await access(path, constants.R_OK)),
    },
  })
  const grep = createGrepToolDefinition(root, {
    operations: {
      isDirectory: guarded(root, async (path) => (await stat(path)).isDirectory()),
      readFile: guarded(root, async (path) => await readFile(path, 'utf8')),
    },
  })
  const ls = createLsToolDefinition(root, {
    operations: {
      exists: guarded(root, async (path) => existsSync(path)),
      stat: guarded(root, async (path) => await stat(path)),
      readdir: guarded(root, async (path) => await readdir(path)),
    },
  })
  return [read, grep, createFindToolDefinition(root), ls].map((definition) =>
    confineToRoot(root, definition as ToolDefinition),
  )
}
