import { describe, it, expect } from 'vitest'
import { obj, str, throwOnGraphqlErrors } from '../src/json.js'

describe('json helpers', () => {
  it('obj accepts plain objects only', () => {
    expect(obj({ a: 1 })).toEqual({ a: 1 })
    expect(obj([1])).toBeUndefined()
    expect(obj(null)).toBeUndefined()
    expect(obj('x')).toBeUndefined()
  })

  it('str trims strings and blanks everything else', () => {
    expect(str('  a ')).toBe('a')
    expect(str(5)).toBe('')
    expect(str(undefined)).toBe('')
  })

  it('throwOnGraphqlErrors names the operation and the first message', () => {
    expect(() => throwOnGraphqlErrors({ errors: [{ message: 'boom' }, { message: 'later' }] }, 'op')).toThrow('op failed: boom')
    expect(() => throwOnGraphqlErrors({ errors: [{}] }, 'op')).toThrow('op failed: GraphQL error')
    expect(() => throwOnGraphqlErrors({ errors: [] }, 'op')).not.toThrow()
    expect(() => throwOnGraphqlErrors({ data: {} }, 'op')).not.toThrow()
  })
})
