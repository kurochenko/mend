import { closeDb, initDb } from '@/db/client'
import { loadConfig } from '@/config'
import { listReviewRuns, type ReviewRunRecord } from '@/db/review-runs'

interface OutputResult {
  assessment?: string
  findings?: unknown[]
  inlineComments?: unknown[]
  skipped?: number
}

const printUsage = (): void => {
  console.log('Usage: bun run runs')
  console.log('   or: bun run runs <project-key>')
  console.log('   or: bun run runs <project-key> <mr-iid>')
  console.log('   or: bun run runs --help')
}

type RunsCommand =
  | { kind: 'help' }
  | { kind: 'invalid' }
  | { kind: 'list'; projectKey?: string; mrIid?: number }

const parseMrIid = (value: string): number => {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid mr-iid: ${value}`)
  }
  return parsed
}

const truncate = (value: string, width: number): string => {
  if (value.length <= width) {
    return value.padEnd(width, ' ')
  }
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

const shortSha = (sha: string | null): string => {
  if (!sha) {
    return '-'
  }
  return sha.slice(0, 10)
}

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null) {
    return '-'
  }
  return `${(durationMs / 1000).toFixed(1)}s`
}

const formatTimestamp = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z')
}

const extractResult = (value: unknown): OutputResult => {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const record = value as Record<string, unknown>
  return {
    assessment: typeof record.assessment === 'string' ? record.assessment : undefined,
    findings: Array.isArray(record.findings) ? record.findings : undefined,
    inlineComments: Array.isArray(record.inlineComments) ? record.inlineComments : undefined,
    skipped: typeof record.skipped === 'number' ? record.skipped : undefined,
  }
}

export const parseRunsArgs = (args: string[]): RunsCommand => {
  if (args.includes('--help') || args.includes('-h')) {
    return { kind: 'help' }
  }
  if (args.length > 2 || args.some((arg) => arg.startsWith('-'))) {
    return { kind: 'invalid' }
  }
  const [projectKey, rawMrIid] = args
  return {
    kind: 'list',
    projectKey,
    mrIid: rawMrIid === undefined ? undefined : parseMrIid(rawMrIid),
  }
}

export const formatRunsTable = (rows: ReviewRunRecord[]): string[] => {
  if (rows.length === 0) {
    return ['No runs found.']
  }

  const header = [
    truncate('RUN ID', 36),
    truncate('MR', 18),
    truncate('SHA', 10),
    truncate('MODEL', 30),
    truncate('STATUS', 8),
    truncate('ASSESSMENT', 16),
    truncate('SRC', 16),
    truncate('FINDINGS', 8),
    truncate('INLINE', 8),
    truncate('SKIPPED', 8),
    truncate('DURATION', 9),
    truncate('CREATED', 22),
  ].join('  ')

  return [
    header,
    ...rows.map((row) => {
      const result = extractResult(row.result)
      return [
        truncate(row.id, 36),
        truncate(`${row.projectKey}!${row.mrIid}`, 18),
        truncate(shortSha(row.commitSha), 10),
        truncate(row.model, 30),
        truncate(row.status, 8),
        truncate(result.assessment ?? '-', 16),
        truncate(row.source, 16),
        truncate(result.findings ? String(result.findings.length) : '-', 8),
        truncate(result.inlineComments ? String(result.inlineComments.length) : '-', 8),
        truncate(result.skipped !== undefined ? String(result.skipped) : '-', 8),
        truncate(formatDuration(row.durationMs), 9),
        truncate(formatTimestamp(row.createdAt), 22),
      ].join('  ')
    }),
  ]
}

const main = async (): Promise<void> => {
  const command = parseRunsArgs(Bun.argv.slice(2))
  if (command.kind === 'help') {
    printUsage()
    return
  }
  if (command.kind === 'invalid') {
    printUsage()
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)

  const rows = await listReviewRuns({
    projectKey: command.projectKey,
    mrIid: command.mrIid,
    limit: 50,
  })

  for (const line of formatRunsTable(rows)) {
    console.log(line)
  }
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeDb()
    })
}
