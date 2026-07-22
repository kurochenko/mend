const MASK = '[masked]'

const distinctValues = (values: string[]): string[] =>
  [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  )

export const maskText = (text: string, secrets: string[]): string => {
  let masked = text
  for (const secret of distinctValues(secrets)) {
    masked = masked.split(secret).join(MASK)
  }
  return masked
}

export const maskCommandResult = <T extends { stdout: string; stderr: string }>(
  result: T,
  secrets: string[],
): T => ({
  ...result,
  stdout: maskText(result.stdout, secrets),
  stderr: maskText(result.stderr, secrets),
})
