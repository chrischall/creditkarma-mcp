import { describe, it, expect } from 'vitest'
import { CkAuthError, isCkAuthError } from '../src/authError.js'

describe('CkAuthError', () => {
  it('carries its reason and message', () => {
    const err = new CkAuthError('no_credentials', 'nothing readable')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CkAuthError')
    expect(err.reason).toBe('no_credentials')
    expect(err.message).toBe('nothing readable')
    expect(err.status).toBeUndefined()
  })

  it('carries an HTTP status for session_rejected', () => {
    const err = new CkAuthError('session_rejected', 'CK said no', 400)
    expect(err.reason).toBe('session_rejected')
    expect(err.status).toBe(400)
  })
})

describe('isCkAuthError', () => {
  it('matches any CkAuthError when no reason is given', () => {
    expect(isCkAuthError(new CkAuthError('session_stale', 'x'))).toBe(true)
  })

  it('matches only the requested reason', () => {
    const err = new CkAuthError('session_rejected', 'x', 400)
    expect(isCkAuthError(err, 'session_rejected')).toBe(true)
    expect(isCkAuthError(err, 'no_credentials')).toBe(false)
  })

  it('rejects plain errors and non-errors', () => {
    expect(isCkAuthError(new Error('boom'))).toBe(false)
    expect(isCkAuthError('boom')).toBe(false)
    expect(isCkAuthError(null)).toBe(false)
  })
})
