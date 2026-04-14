#!/usr/bin/env node
/**
 * Credit Karma MCP auth setup.
 *
 * Launches the user's system Chrome with a dedicated profile, navigates to
 * creditkarma.com, waits for them to sign in, then captures the `CKAT` cookie
 * value (holds both the access and refresh JWTs, URL-encoded-joined with %3B).
 *
 * Usage:
 *   setup-auth.mjs             -> prints CKAT to stdout
 *   setup-auth.mjs <ENV_FILE>  -> writes CK_COOKIES=<ckat> to ENV_FILE
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
  try {
    return (await import('puppeteer-core')).default;
  } catch {
    console.log('Installing puppeteer-core (~1 MB, one time)...');
    execSync('npm install --no-save puppeteer-core', {
      stdio: 'inherit',
      cwd: projectRoot,
    });
    return (await import('puppeteer-core')).default;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: setup-auth.mjs [ENV_FILE]');
    console.log('');
    console.log('  With no arg, prints the CKAT cookie value to stdout.');
    console.log('  With ENV_FILE, writes CK_COOKIES=<ckat> to that file');
    console.log('  (e.g. .env) at mode 0600 and does not print the secret.');
    return;
  }
  const envFile = args[0] ? path.resolve(args[0]) : null;

  const chromePath = findChrome();
  if (!chromePath) {
    console.error(
      `Could not find Google Chrome. Install from https://chrome.google.com/` +
        ` or run the manual steps in README.md (DevTools → copy CKAT cookie).`
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
  console.log('Sign in to Credit Karma when the window opens. The script will');
  console.log('detect the login automatically and close the browser.');
  console.log('');

  // Credit Karma runs a WAF fingerprint check and serves a "We'll be right
  // back" block page if it detects automation. Strip the tells:
  //   - drop --enable-automation (sets navigator.webdriver + infobar)
  //   - add --disable-blink-features=AutomationControlled (the actual gate)
  //   - override navigator.webdriver on every new document just in case
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    userDataDir: profileDir,
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const [page] = await browser.pages();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const ckat = await waitForLogin(page);

  if (!ckat) {
    killBrowser(browser);
    console.error(
      `Timed out after ${TIMEOUT_MS / 60000} minutes without detecting a login.`
    );
    process.exit(1);
  }

  // Graceful browser.close() often stalls for several seconds waiting on Chrome
  // to finish tearing down its profile; we already have what we need, so kill.
  killBrowser(browser);

  if (envFile) {
    writeEnvVar(envFile, 'CK_COOKIES', ckat);
    console.log('');
    console.log(`Wrote CK_COOKIES to ${envFile}`);
    console.log('Restart Claude to pick it up.');
  } else {
    console.log('');
    console.log('CK_COOKIES (paste into Claude Desktop / MCPB config):');
    console.log('');
    console.log(ckat);
    console.log('');
    console.log('Tip: re-run with a path to write it directly to an env file,');
    console.log('e.g. `npm run auth -- .env`.');
  }
}

/** Hard-kill the Chrome process behind a puppeteer Browser handle. */
function killBrowser(browser) {
  const proc = browser.process();
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
}

/**
 * Polls the page's cookie jar every second until the CKAT cookie appears and
 * returns its value. Returns null on timeout.
 */
async function waitForLogin(page) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const cookies = await page.cookies('https://www.creditkarma.com').catch(() => []);
    const ckat = cookies.find((c) => c.name === REQUIRED_COOKIE);
    if (ckat?.value) return ckat.value;
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
