export interface Page<T> {
  items: T[]
  hasMore: boolean
}

export const paginate = <T>(items: T[], page: number, pageSize: number): Page<T> => {
  const start = page * pageSize
  const end = start + pageSize
  return {
    items: items.slice(start, end),
    hasMore: end <= items.length,
  }
}

export const totalPages = (count: number, pageSize: number): number => Math.ceil(count / pageSize)
