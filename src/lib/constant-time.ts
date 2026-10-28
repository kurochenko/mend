import { timingSafeEqual } from 'node:crypto'

export const constantTimeEquals = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  )
}
