import { describe, it, expect, vi, afterEach } from 'vitest'

// fleet-audit#387: a chmod the user's filesystem refuses (EPERM on a directory
// they don't own, a read-only mount, …) must not stop the server from starting.
const chmodSync = vi.hoisted(() => vi.fn())
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, chmodSync }
})

const { hardenDbPermissions } = await import('../src/db.js')

describe('hardenDbPermissions — chmod failures', () => {
  afterEach(() => { vi.restoreAllMocks(); chmodSync.mockReset() })

  it('warns on stderr instead of throwing when a chmod is refused', () => {
    chmodSync.mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => hardenDbPermissions('/some/dir/ck.db', { hardenDir: true })).not.toThrow()
    expect(chmodSync).toHaveBeenCalledWith('/some/dir', 0o700)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not set permissions on \/some\/dir.*EPERM/))
  })

  it('reports a non-Error throw too', () => {
    chmodSync.mockImplementation(() => { throw 'refused' })
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => hardenDbPermissions('/some/dir/ck.db')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ck\.db — refused/))
  })

  it('does not touch the directory unless asked to', () => {
    hardenDbPermissions('/some/dir/ck.db')
    expect(chmodSync).not.toHaveBeenCalledWith('/some/dir', expect.anything())
    expect(chmodSync).toHaveBeenCalledWith('/some/dir/ck.db', 0o600)
  })
})
