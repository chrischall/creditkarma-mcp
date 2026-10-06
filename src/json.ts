/** Narrowing helpers for the untyped JSON Credit Karma and Intuit return. */

export type Json = Record<string, unknown>

/** `v` as a plain object, or undefined for anything else (arrays included). */
export function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
}

/** `v` trimmed if it is a string, else ''. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Throw `<what> failed: <message>` for the first GraphQL error, if any. */
export function throwOnGraphqlErrors(json: unknown, what: string): void {
  const errors = obj(json)?.['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    const message = obj(errors[0])?.['message']
    throw new Error(`${what} failed: ${typeof message === 'string' ? message : 'GraphQL error'}`)
  }
}
