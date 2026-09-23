import { tmpdir } from 'os'
import { join } from 'path'

// Never let a test read (or write) the developer's real saved session at
// ~/.creditkarma-mcp/session. Each worker gets a path that does not exist;
// tests that exercise the file point CK_SESSION_PATH somewhere of their own.
process.env.CK_SESSION_PATH = join(
  tmpdir(),
  `ck-session-isolated-${process.pid}-${Math.random().toString(36).slice(2)}`,
  'session',
)
