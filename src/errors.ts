import { categoryForCode } from './failures.ts'
import type { FailureCategory, FailureFact } from './types.ts'

export class AuxiliaryRuntimeError extends Error {
  readonly category: FailureCategory
  readonly code: string

  constructor(code: string, message: string, category?: FailureCategory) {
    super(message)
    this.name = 'AuxiliaryRuntimeError'
    this.code = code
    this.category = category ?? categoryForCode(code)
  }

  toFact(): FailureFact {
    return { category: this.category, code: this.code }
  }
}
