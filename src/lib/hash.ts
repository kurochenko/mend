export const hashBody = (body: string): string => {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(body)
  return hasher.digest('hex').slice(0, 8)
}
