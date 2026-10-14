# Token refresh: capturing ground truth

How to check what creditkarma.com itself sends to refresh its tokens, and
diff it against what `creditkarma-mcp` sends. Use this whenever refresh starts
failing with a session that is plainly fresh.

## What the web app does (prime_web 2.0.35, read 2026-10-13)

Two call sites in the `prime_web` bundle — `refreshViaMobileApi` (the urql
client, after a GraphQL 401) and `webAuthRefreshCkatCookie` (server-component
pages) — both send:

```
POST https://api.creditkarma.com/mobile/4.5/oauth2/token
ck-client-name:    prime_web
ck-client-version: 2.0.35
ck-device-type:    Desktop
content-type:      application/json
accept:            multipart/mixed; deferSpec=20220824, application/json
ck-trace-id:       <access JWT's glid claim>        (when present)
ck-cookie-id:      <CKTRKID cookie>
authorization:     Bearer <access JWT>

{"refreshToken":"<refresh JWT>"}
```

The response is `{"accessToken":…, "refreshToken":…}`. The page then writes
`CKAT=<access>%3B<refresh>; Secure; Domain=.creditkarma.com; Path=/` itself
with `document.cookie` (`writeWebAccessTokenCookie`). No Cookie header goes
with the refresh: www → api is a cross-origin fetch without
`credentials: 'include'`.

A 200 is only a success if it carries an `accessToken`. Verified live on
2026-10-13: a forced refresh on a session 4 minutes old returned
`200 {"accessToken","refreshToken","traceId"}` from `server: CK-FG-server`. Its
`set-cookie` names were `ak_bmsc`, `bm_sz` and `Access-Control-Allow-Credentials`;
it set no `CKAT`. A transactions page then loaded with the rotated token.

## Reading a failed refresh: check `server` first

| Response | Who answered | Meaning |
|---|---|---|
| `200 {"errorCode":"SecErr"…}`, `server: AkamaiNetStorage` | Akamai edge (a static file, last-modified 2019) | Never reached CK. Usually `Origin` or a browser `User-Agent` is missing. Fix the request, don't re-sign in. |
| empty `400`, `server: CK-FG-server` | CK | CK refused the refresh token, typically because it already ended the session. Sign in again. |
| `400 text/html` from `/member/oauth2/refresh` | CK | The retired route (below). |

The `SecErr` body looks like a token verdict, and it fooled this
investigation once. A dummy-token probe got `SecErr` without `Origin` and an
empty 400 with it, and that read as if `Origin` were what got the request
refused. It was the reverse. `SecErr` was Akamai declining to forward, and the
empty 400 was CK itself rejecting the dummy token. Removing `Origin` turned a
live refresh into the canned `SecErr`.

```
dummy token, header ablation (2026-10-13)
Origin + browser User-Agent   → 400 ""      server: CK-FG-server    (reached CK)
either one missing            → 200 SecErr  server: AkamaiNetStorage (edge block)
```

## A young token can still be dead

The first live refresh at the new endpoint used a refresh token 23 minutes
old with 7½ hours left before `exp`. It got an empty 400 from CK. The browser
tab had sat idle, and when it was next used it demanded a fresh sign-in. CK
had already ended the session server-side, most likely through its inactivity
timeout (`session-timeout` bundle → `accounts.creditkarma.com/logout?inactive=1`),
though the cause wasn't confirmed. A sign-in fixed it. So `iat`/`exp` can't
prove a session alive, and `ck_healthcheck` advises signing in again whenever
CK rejects the refresh, explaining why when the token looks new. The
"don't re-sign in" case is the Akamai block above.

## Why the old request got a 400

Until 3.3.2 the MCP refreshed at `https://www.creditkarma.com/member/oauth2/refresh`
with `ck-client-name: web`. That route is retired: it answers **every** request
— a dummy refresh token, no cookies, no Authorization — with the same
`400 text/html` error page from `server: CK-FG-server`. A dead route read as a
dead session, which is why the failure reproduced unchanged across a full
sign-out and sign-in. Reproduced 2026-10-13 from Node with a dummy token
(`{"refreshToken":"x"}`, the old header set, no credentials):

```
POST https://www.creditkarma.com/member/oauth2/refresh
→ 400  content-type: text/html  server: CK-FG-server
  <!DOCTYPE html><html lang="en"><head>… ck-assets.imgix.net/assets/1.94.2/error.png …
```

## Re-checking it yourself

### From the bundle (no session needed)

1. Open any signed-in creditkarma.com page. In the DevTools console, list its
   scripts:
   ```js
   performance.getEntriesByType('resource').map(e => e.name).filter(u => u.endsWith('.js'))
   ```
2. The chunks live on the public CDN
   (`creditkarmacdn-a.akamaihd.net/res/content/bundles/prime_web/<ver>/_next/static/chunks/`).
   Download them and search for `oauth2/token` and `transformPropertiesToHeaders`.

### From a live request (DevTools → Network)

The page only refreshes when its access token runs out (~15 min after sign-in),
so either leave a tab open past that and then navigate within the app, or wait
for a GraphQL 401.

1. DevTools → **Network**, enable **Preserve log**, filter `oauth2`.
2. Click the `token` request (`api.creditkarma.com/mobile/4.5/oauth2/token`).
3. Compare **Request Headers** names and the **Payload** shape with the block
   above, and with the MCP's `refresh.request` debug line.
4. If you share anything, **delete the `authorization` header, the
   `refreshToken` value and the response body** first — they are live
   credentials.

### From the MCP

Restart the server with `CK_DEBUG=1`. Every refresh logs to stderr:

- `auth.fetchproxy` — the URL the bridge read cookies for, and the cookie NAMES it got
- `auth.resolved` — the credential source, cookie names, and both JWTs' `iat`/`exp`
- `refresh.request` — URL, method, header names, body shape, JWT timings
- `refresh.response` — status, response headers (`set-cookie` reduced to cookie NAMES), first 500
  chars of the body with tokens redacted
- `refresh.error` — a transport failure that never got a status

Tokens, cookie values and refresh tokens never appear in these lines.

## Caution

Every successful refresh ROTATES the refresh token. The browser and the MCP
share one `CKAT`, so a refresh the MCP performs signs the browser tab out the
next time the page tries to use its own (now rotated-out) refresh token. Don't
loop refresh experiments against a real account.
