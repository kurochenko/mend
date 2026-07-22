import { lookupContext7 } from '../src/integrations/context7'

const printUsage = (): void => {
  console.log(
    'Usage: bun run tools/context7-fetch.ts <query> [--library <name-or-id>] [--limit <n>]',
  )
}

const parseArgs = (
  args: string[],
): {
  query: string
  library?: string
  limit: number
} => {
  const query = args[0]
  if (!query) {
    throw new Error('Missing query')
  }

  let library: string | undefined
  let limit = 5

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--library') {
      library = args[i + 1]
      i++
      continue
    }
    if (arg === '--limit') {
      const raw = args[i + 1]
      i++
      if (!raw) {
        throw new Error('Missing value for --limit')
      }
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${raw}`)
      }
      limit = parsed
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return { query, library, limit }
}

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2)
  if (args.length === 0) {
    printUsage()
    process.exitCode = 1
    return
  }

  const parsed = parseArgs(args)
  const result = await lookupContext7(parsed)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
