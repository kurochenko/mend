export class ProviderApiError extends Error {
  status: number
  method: string

  constructor(params: { message: string; status: number; method: string }) {
    super(params.message)
    this.name = 'ProviderApiError'
    this.status = params.status
    this.method = params.method
  }
}
