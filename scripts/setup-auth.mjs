#!/usr/bin/env node
/**
 * Credit Karma MCP auth setup.
 *
 * Launches the user's system Chrome with a dedicated profile, navigates to
 * creditkarma.com, waits for them to sign in, then captures the full session
 * cookie header (CKAT carries the access + refresh JWTs; CKTRKID and friends
 * are needed by the refresh endpoint).
 *
 * Usage:
 *   setup-auth.mjs                       -> prints the Cookie header to stdout
 *   setup-auth.mjs <ENV_FILE>            -> writes CK_COOKIES=<header> to ENV_FILE
 *   setup-auth.mjs --manual [<ENV_FILE>] -> prompts you to paste a Cookie header
 *                                           copied from your normal Chrome.
 *                                           Use this if the automated flow
 *                                           hits Intuit/Akamai bot detection.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const LOGIN_URL = 'https://www.creditkarma.com/auth/logon';
const REQUIRED_COOKIE = 'CKAT';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to sign in

/**
 * Returns an absolute path to a runnable Google Chrome binary, or null if
 * none is found in known install locations.
 */
function findChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  }[process.platform] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Serialize a Puppeteer cookie jar (array of {name, value}) into a Cookie
 * header string. Drops entries missing either field. Pure / exported for tests.
 */
export function cookiesToHeader(cookies) {
  return cookies
    .filter((c) => c?.name && c?.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Updates (or creates) an env file, setting KEY=VALUE for a single key while
 * preserving any other lines in the file. File permissions are set to 0600.
 */
export function writeEnvVar(envPath, key, value) {
  let contents = '';
  if (fs.existsSync(envPath)) {
    contents = fs.readFileSync(envPath, 'utf8');
  }
  const lineRe = new RegExp(`^${key}=.*$`, 'm');
  if (lineRe.test(contents)) {
    contents = contents.replace(lineRe, `${key}=${value}`);
  } else {
    if (contents && !contents.endsWith('\n')) contents += '\n';
    contents += `${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, contents, { mode: 0o600 });
}

async function loadPuppeteer() {
  async function tryImport() {
    const core = (await import('puppeteer-core')).default;
    const { addExtra } = await import('puppeteer-extra');
    const Stealth = (await import('puppeteer-extra-plugin-stealth')).default;
    const wrapped = addExtra(core);

    // Disable Stealth's `navigator.webdriver` evasion. Its beforeLaunch pushes
    // --disable-blink-features=AutomationControlled into the args list, which
    // makes recent Chrome show a yellow "unsupported command-line flag"
    // warning bar — and that warning bar grows the window chrome by ~30px in
    // a way outerHeight/innerHeight fingerprinting catches. We already drop
    // --enable-automation via ignoreDefaultArgs (which disables the
    // AutomationControlled blink feature), and the evasion's JS-side patch is
    // a no-op when navigator.webdriver is already undefined, so disabling
    // this evasion is purely upside.
    const stealth = Stealth();
    stealth.enabledEvasions.delete('navigator.webdriver');
    wrapped.use(stealth);
    return wrapped;
  }
  try {
    return await tryImport();
  } catch {
    console.log('Installing puppeteer-core + puppeteer-extra-plugin-stealth (one time)...');
    execSync(
      'npm install --no-save puppeteer-core puppeteer-extra puppeteer-extra-plugin-stealth',
      { stdio: 'inherit', cwd: projectRoot }
    );
    return await tryImport();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: setup-auth.mjs [--manual] [ENV_FILE]');
    console.log('');
    console.log('  With no arg, prints the captured Cookie header to stdout.');
    console.log('  With ENV_FILE, writes CK_COOKIES=<header> to that file');
    console.log('  (e.g. .env) at mode 0600 and does not print the secret.');
    console.log('  With --manual, skips the browser and prompts you to paste a');
    console.log('  Cookie header copied from your normal Chrome (DevTools →');
    console.log('  Network → any creditkarma.com request → Request Headers).');
    return;
  }
  const manual = args.includes('--manual');
  const positional = args.filter((a) => !a.startsWith('--'));
  const envFile = positional[0] ? path.resolve(positional[0]) : null;

  if (manual) {
    await runManual(envFile);
    return;
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.error(
      `Could not find Google Chrome. Install from https://chrome.google.com/` +
        ` or run the manual steps in README.md (DevTools → copy Cookie header).`
    );
    process.exit(1);
  }

  const puppeteer = await loadPuppeteer();

  const profileDir = path.join(os.homedir(), '.creditkarma-mcp', 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  console.log('');
  console.log('Launching Chrome with a dedicated profile at:');
  console.log(`  ${profileDir}`);
  console.log('');
  console.log('The browser will open on creditkarma.com. Click "Sign In" at the');
  console.log('top right and complete your login — the script will detect the');
  console.log('session cookies and close the browser automatically.');
  console.log('');
  console.log('If you hit "A technical issue has unexpectedly occurred" on sign-in,');
  console.log('that is Intuit/Akamai bot detection. Bail out (Ctrl+C) and re-run');
  console.log('with --manual to paste the cookie from your normal Chrome instead.');
  console.log('');

  // puppeteer-extra-plugin-stealth (loaded in loadPuppeteer) applies ~15
  // browser-fingerprint evasions covering webdriver, plugins, languages,
  // chrome.runtime, permissions, WebGL, navigator.userAgentData, iframe
  // contentWindow, media codecs, and more. The plugin is the canonical bypass
  // for Akamai-fronted login pages that serve "We'll Be Right Back" block
  // pages when they detect automation.
  //
  // We still drop --enable-automation explicitly (defense in depth — it sets
  // the AutomationControlled blink feature) and skip
  // --disable-blink-features=AutomationControlled because recent Chrome shows
  // an "unsupported command-line flag" warning bar for it, which itself is a
  // viewport-fingerprint tell.
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    userDataDir: profileDir,
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const [page] = await browser.pages();

  // The persistent profile retains cookies between runs. When CKAT has expired
  // but other CK session cookies haven't, the logon page renders "Welcome
  // back, NAME" and hangs on a loading spinner while a doomed auth call
  // retries in the background — leaving no login form to click. Drop the jar
  // on every run so the user always lands on a real login form. Saved
  // passwords and localStorage in the profile are preserved.
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.clearBrowserCookies');
  // Land on the homepage and let the user click "Sign In" themselves. A
  // programmatic page.goto(LOGIN_URL) skips CK's JS click handler, which sets
  // session-init signals that Intuit/Akamai's auth-endpoint risk check
  // requires — without those, sign-in POSTs return a generic "A technical
  // issue has unexpectedly occurred". A real click goes through that handler.
  await page.goto('https://www.creditkarma.com/', { waitUntil: 'domcontentloaded' });

  const cookieHeader = await waitForLogin(page);

  if (!cookieHeader) {
    killBrowser(browser);
    console.error(
      `Timed out after ${TIMEOUT_MS / 60000} minutes without detecting a login.`
    );
    console.error('');
    console.error('If sign-in kept failing with "A technical issue has unexpectedly');
    console.error('occurred", that is bot detection. Re-run with --manual to paste');
    console.error('the Cookie header from your normal Chrome session instead.');
    process.exit(1);
  }

  // Graceful browser.close() often stalls for several seconds waiting on Chrome
  // to finish tearing down its profile; we already have what we need, so kill.
  killBrowser(browser);

  if (envFile) {
    writeEnvVar(envFile, 'CK_COOKIES', cookieHeader);
    console.log('');
    console.log(`Wrote CK_COOKIES to ${envFile}`);
    console.log('Restart Claude to pick it up.');
  } else {
    console.log('');
    console.log('CK_COOKIES (paste into Claude Desktop / MCPB config):');
    console.log('');
    console.log(cookieHeader);
    console.log('');
    console.log('Tip: re-run with a path to write it directly to an env file,');
    console.log('e.g. `npm run auth -- .env`.');
  }
}

/**
 * Manual cookie capture: prompts the user (no-echo, like a password prompt) to
 * paste a Cookie header copied from their normal Chrome — where Intuit/Akamai's
 * auth-endpoint risk check accepts the session. Use when the automated
 * puppeteer flow keeps failing on the sign-in POST. The runtime parser in
 * src/tools/auth.ts also accepts a bare CKAT value or `CKAT=<value>`, but the
 * full Cookie header is preferred because refresh requests need CKTRKID.
 */
async function runManual(envFile) {
  console.log('');
  console.log('Manual cookie capture');
  console.log('=====================');
  console.log('1. Sign in to https://www.creditkarma.com in your normal Chrome');
  console.log('2. Open DevTools (Cmd+Opt+I) → Network tab');
  console.log('3. Click any request to creditkarma.com → Request Headers →');
  console.log('   right-click the "cookie" header → Copy value');
  console.log('4. Paste it at the prompt below and press Enter. Input is not');
  console.log('   echoed — your terminal will look frozen until you press Enter.');
  console.log('');

  const cookieHeader = await promptSecret('Cookie header: ');

  if (!cookieHeader) {
    console.error('No value entered. Aborting.');
    process.exit(1);
  }

  if (envFile) {
    writeEnvVar(envFile, 'CK_COOKIES', cookieHeader);
    console.log('');
    console.log(`Wrote CK_COOKIES to ${envFile}`);
    console.log('Restart Claude to pick it up.');
  } else {
    console.log('');
    console.log('CK_COOKIES (paste into Claude Desktop / MCPB config):');
    console.log('');
    console.log(cookieHeader);
  }
}

/**
 * Strip bracketed-paste escape markers (`ESC [ 200 ~` ... `ESC [ 201 ~`) that
 * some terminals wrap around pasted content when stdin is in raw mode, and
 * trim surrounding whitespace. Exported for tests.
 */
export function cleanPastedCookie(raw) {
  return raw
    .replace(/\[200~/g, '')
    .replace(/\[201~/g, '')
    .trim();
}

/**
 * Reads a secret from stdin without echoing it (like a password prompt).
 * Handles paste-as-one-chunk, backspace, Enter to submit, Ctrl-C to abort,
 * and bracketed-paste markers. Falls back to a plain end-of-stream read on
 * non-TTY input (CI, pipes).
 */
function promptSecret(question) {
  process.stdout.write(question);
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => (buf += chunk));
      stdin.on('end', () => resolve(cleanPastedCookie(buf)));
    });
  }

  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const finish = (extra = '') => {
      cleanup();
      process.stdout.write('\n');
      resolve(cleanPastedCookie(value + extra));
    };

    const onData = (key) => {
      // Ctrl-C
      if (key === '') {
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }
      // Enter (CR) or LF on its own = submit
      if (key === '\r' || key === '\n') {
        finish();
        return;
      }
      // Backspace (DEL 0x7f, BS 0x08)
      if (key === '' || key === '') {
        if (value.length > 0) value = value.slice(0, -1);
        return;
      }
      // A pasted chunk may itself contain a newline (terminal sends the whole
      // paste as one data event). Treat the first newline inside the chunk as
      // end-of-input so users don't have to press Enter twice.
      const nlIdx = key.search(/[\r\n]/);
      if (nlIdx !== -1) {
        finish(key.slice(0, nlIdx));
        return;
      }
      value += key;
    };

    stdin.on('data', onData);
  });
}

/** Hard-kill the Chrome process behind a puppeteer Browser handle. */
function killBrowser(browser) {
  const proc = browser.process();
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
}

/**
 * Polls the page's cookie jar every second until the CKAT cookie appears, then
 * returns the full Cookie header (all creditkarma.com cookies serialized as
 * `name=value; ...`). The refresh endpoint needs CKTRKID and friends alongside
 * CKAT, so we capture the whole jar rather than the CKAT value alone. Returns
 * null on timeout.
 */
async function waitForLogin(page) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const cookies = await page.cookies('https://www.creditkarma.com').catch(() => []);
    if (cookies.some((c) => c.name === REQUIRED_COOKIE && c.value)) {
      return cookiesToHeader(cookies);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// Only run main() when executed directly, not when imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Setup failed:', err?.message ?? err);
    process.exit(1);
  });
}
