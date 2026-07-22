import { closeDb, initDb } from '@/db/client'
import { loadConfig } from '@/config'
import { listReviewRuns, type ReviewRunRecord } from '@/db/review-runs'

interface OutputResult {
  assessment?: string
  findings?: unknown[]
  inlineComments?: unknown[]
  reviewTemplateId?: string
  reviewTemplateSource?: string
  skipped?: number
}

const printUsage = (): void => {
  console.log('Usage: bun run runs')
  console.log('   or: bun run runs <project-key>')
  console.log('   or: bun run runs <project-key> <mr-iid>')
}

const parseMrIid = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
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
    reviewTemplateId:
      typeof record.reviewTemplateId === 'string' ? record.reviewTemplateId : undefined,
    reviewTemplateSource:
      typeof record.reviewTemplateSource === 'string' ? record.reviewTemplateSource : undefined,
    skipped: typeof record.skipped === 'number' ? record.skipped : undefined,
  }
}

const printRows = (rows: ReviewRunRecord[]): void => {
  if (rows.length === 0) {
    console.log('No runs found.')
    return
  }

  const header = [
    truncate('RUN ID', 36),
    truncate('MR', 18),
    truncate('SHA', 10),
    truncate('MODEL', 30),
    truncate('STATUS', 8),
    truncate('ASSESSMENT', 16),
    truncate('TEMPLATE', 18),
    truncate('SRC', 10),
    truncate('FINDINGS', 8),
    truncate('INLINE', 8),
    truncate('SKIPPED', 8),
    truncate('DURATION', 9),
    truncate('CREATED', 22),
  ].join('  ')
  console.log(header)

  for (const row of rows) {
    const result = extractResult(row.result)
    const line = [
      truncate(row.id, 36),
      truncate(`${row.projectKey}!${row.mrIid}`, 18),
      truncate(shortSha(row.commitSha), 10),
      truncate(row.model, 30),
      truncate(row.status, 8),
      truncate(result.assessment ?? '-', 16),
      truncate(result.reviewTemplateId ?? '-', 18),
      truncate(result.reviewTemplateSource ?? '-', 10),
      truncate(result.findings ? String(result.findings.length) : '-', 8),
      truncate(result.inlineComments ? String(result.inlineComments.length) : '-', 8),
      truncate(result.skipped !== undefined ? String(result.skipped) : '-', 8),
      truncate(formatDuration(row.durationMs), 9),
      truncate(formatTimestamp(row.createdAt), 22),
    ].join('  ')
    console.log(line)
  }
}

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2)
  if (args.length > 2) {
    printUsage()
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)

  const projectKey = args[0]
  const mrIid = args[1] ? parseMrIid(args[1]) : undefined

  const rows = await listReviewRuns({
    projectKey,
    mrIid,
    limit: 50,
  })

  printRows(rows)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
