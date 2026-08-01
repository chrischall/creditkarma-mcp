/**
 * One error type for every way CK auth can fail, tagged with WHICH way.
 *
 * Before this existed, "the fetchproxy extension couldn't read any cookies"
 * and "we read cookies fine but Credit Karma rejected them" both surfaced as
 * bare `Error`s whose text a caller had to pattern-match — so `refreshOrThrow`
 * couldn't tell a recoverable stale session (re-read the browser cookies and
 * try again) from a terminal one (the user has to sign in), and the operator
 * couldn't tell them apart either.
 *
 * Lives in its own module so both `client.ts` (which throws `session_rejected`)
 * and `auth.ts` (which throws `no_credentials` / `session_stale`) can import it
 * without a cycle.
 */
export type CkAuthReason =
  /** fetchproxy/env produced no usable CKAT — nothing to authenticate with. */
  | 'no_credentials'
  /** Credentials were readable, but the refresh JWT's own `exp` is in the past.
   *  Detected locally, before any network call. */
  | 'session_stale'
  /** Credentials looked usable and CK rejected them at `/member/oauth2/refresh`. */
  | 'session_rejected'

export class CkAuthError extends Error {
  readonly reason: CkAuthReason
  /** HTTP status from the refresh endpoint. Only set for `session_rejected`. */
  readonly status?: number

  constructor(reason: CkAuthReason, message: string, status?: number) {
    super(message)
    this.name = 'CkAuthError'
    this.reason = reason
    if (status !== undefined) this.status = status
  }
}

/** True when `err` is a {@link CkAuthError} carrying `reason`. Narrow helper so
 *  callers don't re-implement the instanceof + field check (and don't fall back
 *  to matching on message text, which is what this class exists to end). */
export function isCkAuthError(err: unknown, reason?: CkAuthReason): err is CkAuthError {
  return err instanceof CkAuthError && (reason === undefined || err.reason === reason)
}
