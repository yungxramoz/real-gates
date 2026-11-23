#!/usr/bin/env node
// What this project is built with, as the loop sees it.
//
//   node loop/scripts/stack.mjs           the project's stack: its blocks, and what they add up to
//   node loop/scripts/stack.mjs --list    every block the harness ships, by category; a block no
//                                         project has run on yet is marked as a draft
//   node loop/scripts/stack.mjs --json    the same as JSON, for a program
//
// A project's settings are spread over its blocks (loop/stack/), the profile it names and its own
// loop/loop.config.json. This prints the result, so nobody has to merge them in their head: which
// work types there are and how each is accepted, what the local gate runs, which guard packs are
// on, what the runner does after a merge and whether something is deployed.
//
// Node built-ins only. Exit 0, or 1 with the reason when the config cannot be read.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';
import { CATEGORIES, blockIds, loadBlock, loadStack } from '../lib/stack.mjs';

const USAGE = 'usage: node loop/scripts/stack.mjs [--list] [--json] [--root <dir>]';

/** Every shipped block, by category: { category, what, blocks: [{ id, title, description, choose }] }. */
export function catalogue(root) {
  const blocks = blockIds(root).map((id) => loadBlock(root, id));
  return Object.entries(CATEGORIES).map(([category, rule]) => ({ category, what: rule.what, holds: rule.one ? 'exactly one' : rule.atMostOne ? 'one or none' : 'any number', blocks: blocks.filter((b) => b.category === category).map(({ id, title, description, choose, status }) => ({ id, title, description, choose, status })) }));
}

/** The stack of the repo at `root` and what its config comes to. Throws what loadConfig throws. */
export function describeStack(root) {
  const cfg = loadConfig(root);
  return {
    profile: cfg.profile || null,
    stack: loadStack(root, cfg.stack).map(({ id, title, status }) => ({ id, title, status })),
    workTypes: Object.fromEntries(Object.entries(cfg.workTypes || {}).filter(([, t]) => t)),
    localGate: cfg.localGate?.commands || [],
    guardPacks: cfg.guard?.packs || [],
    postMerge: (cfg.postMerge || []).map((s) => s.adapter),
    deploy: cfg.deploy?.adapter || 'none',
    forge: cfg.forge?.adapter || '',
  };
}

/** What a block that no project has run on yet is marked with. */
const draft = (b) => (b.status === 'proven' ? '' : ' [draft: tested, not yet proven by a project]');

function printCatalogue(root) {
  for (const c of catalogue(root)) {
    console.log(`\n${c.category} (${c.holds}): ${c.what}`);
    if (!c.blocks.length) console.log('  (no block yet)');
    for (const b of c.blocks) console.log(`  ${b.id}: ${b.title}${draft(b)}\n    ${b.description}\n    Choose it when: ${b.choose}`);
  }
}

function printStack(d) {
  console.log(d.profile ? `Profile: ${d.profile}` : 'No profile: the project lists its own blocks.');
  console.log(d.stack.length ? `Stack:\n${d.stack.map((b) => `  ${b.id}: ${b.title}${draft(b)}`).join('\n')}` : 'Stack: none. The loop runs with the core alone: `stack` in loop/loop.config.json lists the blocks.');
  console.log(`Work types:\n${Object.entries(d.workTypes).map(([name, t]) => `  ${name}: ${t.rubric?.length ? `scored on ${t.rubric.join(', ')}` : 'no scores'}; accepted: ${t.accept}`).join('\n')}`);
  console.log(`Local gate: ${d.localGate.join(' && ') || '(none)'}`);
  console.log(`Guard packs: ${d.guardPacks.join(', ') || '(none)'}`);
  console.log(`After a merge: ${d.postMerge.join(', ') || 'nothing'}`);
  console.log(`Deployed: ${d.deploy === 'none' ? 'no' : `yes (${d.deploy})`}`);
  console.log(`Forge: ${d.forge}`);
}

function main(argv) {
  const o = { list: false, json: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') o.list = true;
    else if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--root' && argv[i + 1]) o.root = path.resolve(argv[++i]);
    else {
      console.error(`stack: unknown argument "${argv[i]}"\n${USAGE}`);
      return 1;
    }
  }
  try {
    const out = o.list ? catalogue(o.root) : describeStack(o.root);
    if (o.json) console.log(JSON.stringify(out, null, 2));
    else if (o.list) printCatalogue(o.root);
    else printStack(out);
    return 0;
  } catch (e) {
    console.error(`stack: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
