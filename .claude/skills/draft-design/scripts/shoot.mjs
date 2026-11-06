#!/usr/bin/env node
// Validator for /draft-design: screenshots static HTML mocks at phone and desktop width and reports
// horizontal overflow (the most common mobile defect) and console errors.
//
// Usage: node shoot.mjs <file.html | folder> [...] [--out <folder>]
// A folder is searched recursively for .html files. Screenshots go to <out>/<relative name>-<width>.png,
// by default a "shots" folder next to each mock. Exit 0 when every page fits, 1 with named problems.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HELP = `Usage: node shoot.mjs <file.html | folder> [...] [--out <folder>]

Takes a full-page screenshot of every mock at two widths and checks it fits:
  - 360 px wide: the smallest common phone; every screen must work here
  - 1280 px wide: a common laptop width
Reports each page whose content is wider than the viewport (horizontal scroll) with the
elements that stick out, and any console error the page logs.

  --out <folder>   where the PNGs go (default: a "shots" folder next to each mock)

Needs @playwright/test and its Chromium in the project:
  pnpm add -D @playwright/test && pnpm exec playwright install chromium
Exit code 0 when every page fits, 1 with named problems.`;

const WIDTHS = [360, 1280];
const HEIGHT = 800; // first-screen height for the viewport; screenshots are full page anyway
const SETTLE_MS = 300; // lets web fonts and CSS transitions settle before the shot
const MAX_OFFENDERS = 5; // elements listed per overflowing page; the first few point at the cause

/** A path relative to the current folder when inside it, else absolute; always forward slashes. */
function show(p) {
  const rel = path.relative(process.cwd(), p);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? p : rel).split(path.sep).join('/');
}

function parseArgs(argv) {
  const args = { inputs: [], out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--out') {
      if (!argv[i + 1]) throw new Error('--out needs a folder');
      args.out = argv[++i];
    } else if (argv[i].startsWith('--')) throw new Error(`unknown option "${argv[i]}" (see --help)`);
    else args.inputs.push(argv[i]);
  }
  return args;
}

function collect(input) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new Error(`${input} does not exist`);
  if (fs.statSync(abs).isFile()) return [{ file: abs, base: path.dirname(abs) }];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'shots' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.html?$/i.test(e.name)) out.push({ file: p, base: abs });
    }
  };
  walk(abs);
  return out;
}

/** Loads Playwright from the project first (the current folder), then from beside this script. */
async function loadChromium() {
  for (const from of [path.join(process.cwd(), 'noop.js'), fileURLToPath(import.meta.url)]) {
    for (const name of ['@playwright/test', 'playwright']) {
      try {
        const resolved = createRequire(from).resolve(name);
        const mod = await import(pathToFileURL(resolved).href);
        const chromium = mod.chromium ?? mod.default?.chromium;
        if (chromium) return chromium;
      } catch {
        // try the next location
      }
    }
  }
  return null;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`shoot: ${e.message}`);
    return 1;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!args.inputs.length) {
    console.error('shoot: name at least one .html file or folder (see --help)');
    return 1;
  }

  let pages = [];
  try {
    for (const input of args.inputs) pages.push(...collect(input));
  } catch (e) {
    console.error(`shoot: ${e.message}`);
    return 1;
  }
  if (!pages.length) {
    console.error(`shoot: no .html files in ${args.inputs.join(', ')}`);
    return 1;
  }

  const chromium = await loadChromium();
  if (!chromium) {
    console.error('shoot: Playwright is not installed in this project.\n  Run: pnpm add -D @playwright/test && pnpm exec playwright install chromium');
    return 1;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error(`shoot: Chromium did not start (${e.message.split('\n')[0]}).\n  Run: pnpm exec playwright install chromium`);
    return 1;
  }

  const problems = [];
  try {
    for (const { file, base } of pages) {
      const rel = path.relative(base, file).replace(/\.html?$/i, '');
      const outDir = args.out ? path.resolve(args.out) : path.join(path.dirname(file), 'shots');
      const stem = args.out ? rel.split(path.sep).join('__') : path.basename(rel);
      fs.mkdirSync(outDir, { recursive: true });
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: HEIGHT } });
        const errors = [];
        page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
        page.on('pageerror', (err) => errors.push(err.message));
        try {
          await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
          await page.waitForTimeout(SETTLE_MS);
          const overflow = await page.evaluate((max) => {
            const vw = document.documentElement.clientWidth;
            const sw = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
            if (sw <= vw) return null;
            const describe = (el) => {
              const id = el.id ? `#${el.id}` : '';
              const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
              return `${el.tagName.toLowerCase()}${id}${cls}`;
            };
            const offenders = [];
            for (const el of document.body.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if (r.right > vw + 1 && r.width > 0) {
                // Report the outermost element that sticks out, not each of its children.
                if (!offenders.some((o) => o.el.contains(el))) offenders.push({ el, right: Math.round(r.right) });
              }
              if (offenders.length >= max) break;
            }
            return { vw, sw, offenders: offenders.map((o) => `${describe(o.el)} (right edge ${o.right}px)`) };
          }, MAX_OFFENDERS);
          const shot = path.join(outDir, `${stem}-${width}.png`);
          await page.screenshot({ path: shot, fullPage: true });
          const name = `${show(file)} @ ${width}px`;
          if (overflow) {
            problems.push(`${name}: content is ${overflow.sw}px wide in a ${overflow.vw}px viewport (horizontal scroll); sticking out: ${overflow.offenders.join(', ') || 'unknown'}`);
          }
          for (const err of errors) problems.push(`${name}: console error: ${err}`);
          console.log(`${overflow || errors.length ? 'PROBLEM' : 'ok     '}  ${name} -> ${show(shot)}`);
        } catch (e) {
          problems.push(`${show(file)} @ ${width}px: could not render (${e.message.split('\n')[0]})`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.log(`\nshoot: ${problems.length} problem(s)`);
    for (const p of problems) console.log(`PROBLEM  ${p}`);
    return 1;
  }
  console.log(`\nshoot: ${pages.length} mock(s) fit at ${WIDTHS.join(' px and ')} px`);
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`shoot: unexpected error: ${e.stack || e.message}`);
    process.exitCode = 1;
  },
);
