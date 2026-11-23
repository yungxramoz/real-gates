// Stack blocks: what a project is built with, one block per choice.
//
// A block is a folder loop/stack/<category>/<name>/ with:
//   block.json    { title, description, choose, config }
//                 title, description   what the block is, in a line and in a paragraph
//                 choose               when a project takes it
//                 config               what it adds to the loop config: commands, gate files, work
//                                      types, guard packs, adapters (the keys of loop/lib/config.mjs)
//   prompts/*.md  its words for the steps a session takes. A core prompt pulls them in with
//                 `{{>name}}`; `<name>.<variant>.md` wins over `<name>.md` (see fragmentParts)
//
// A project names its blocks in `stack` (loop/loop.config.json, or the profile it names). This
// module finds them, puts their config together and collects their words. It knows no block by
// name: what a category may hold is all it decides.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The categories, in the order their blocks are put together: the order of the guard packs, of
 * the local gate's commands and of the words in a prompt. `one`: a stack has exactly one block of
 * it. `atMostOne`: one or none.
 */
export const CATEGORIES = Object.freeze({
  forge: { one: true, what: 'where pull requests, CI results and the merge live' },
  toolchain: { one: true, what: 'how the code is checked, tested and kept from getting worse' },
  framework: { what: 'what the code is written with, and so how its source is laid out' },
  product: { what: 'what a user touches, and so how an item is reviewed and a milestone accepted' },
  database: { what: 'where the data lives, and what happens to it after a merge' },
  hosting: { atMostOne: true, what: 'where the merged base runs, if anywhere' },
});

const BLOCK_ID = /^([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;
const INCLUDE = /\{\{>([\w-]+)\}\}/g;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function stackDir(root) {
  return path.join(root, 'loop', 'stack');
}

/** Every block the repo at `root` ships, as `<category>/<name>`, sorted. */
export function blockIds(root) {
  const dirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  return dirs(stackDir(root)).flatMap((c) => dirs(path.join(stackDir(root), c)).filter((n) => fs.existsSync(path.join(stackDir(root), c, n, 'block.json'))).map((n) => `${c}/${n}`)).sort();
}

/** One block: { id, category, name, dir, title, description, choose, config }. Throws a named error when it is not there or not readable. */
export function loadBlock(root, id) {
  const m = BLOCK_ID.exec(String(id));
  const file = m ? path.join(stackDir(root), m[1], m[2], 'block.json') : '';
  if (!m || !fs.existsSync(file)) throw new Error(`stack: "${id}" is not a block under loop/stack/ (known: ${blockIds(root).join(', ') || 'none'})`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`loop/stack/${id}/block.json is not valid JSON: ${e.message}`);
  }
  if (!isPlainObject(json) || (json.config !== undefined && !isPlainObject(json.config))) throw new Error(`loop/stack/${id}/block.json must be an object, with \`config\` an object`);
  return { id: m[0], category: m[1], name: m[2], dir: path.dirname(file), title: json.title || '', description: json.description || '', choose: json.choose || '', config: json.config || {} };
}

/** What is wrong with a list of block ids before any is read: its form, a repeated block, a category that holds too many or too few. */
export function stackProblems(ids) {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) return ['stack must be a list of block names ("<category>/<name>")'];
  const p = [];
  const byCategory = {};
  for (const id of ids) {
    const m = BLOCK_ID.exec(id);
    if (!m) p.push(`stack: "${id}" is not a block name ("<category>/<name>", lowercase)`);
    else if (!CATEGORIES[m[1]]) p.push(`stack: "${id}" names no category (known: ${Object.keys(CATEGORIES).join(', ')})`);
    else if ((byCategory[m[1]] ||= []).includes(id)) p.push(`stack: "${id}" is listed twice`);
    else byCategory[m[1]].push(id);
  }
  if (p.length || !ids.length) return p; // an empty stack is the core alone: nothing to hold it to
  for (const [category, rule] of Object.entries(CATEGORIES)) {
    const has = byCategory[category] || [];
    if (rule.one && has.length === 0) p.push(`stack: no ${category} block. A stack needs one: ${rule.what}`);
    if ((rule.one || rule.atMostOne) && has.length > 1) p.push(`stack: ${has.join(' and ')} are both ${category} blocks. A stack has one: ${rule.what}`);
  }
  return p;
}

/** The blocks of a stack, in the order they are put together: by category (CATEGORIES), then as listed. Throws on a list stackProblems refuses and on an unknown block. */
export function loadStack(root, ids) {
  const problems = stackProblems(ids || []);
  if (problems.length) throw new Error(problems.join('\n'));
  const order = Object.keys(CATEGORIES);
  return (ids || []).map((id) => loadBlock(root, id)).sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

/**
 * The config of several blocks as one: objects merge key by key, lists are joined (a value two
 * blocks name is kept once), and a single value two blocks set differently is a conflict, because
 * neither block can be right about the other's choice. Returns { config, conflicts: [sentence] }.
 */
export function composeStack(blocks) {
  const conflicts = [];
  const setBy = new Map(); // "a.b.c" -> the block that set it first
  const merge = (into, from, at, id) => {
    for (const [key, value] of Object.entries(from)) {
      if (key.startsWith('$')) continue; // $comment and friends
      const here = at ? `${at}.${key}` : key;
      const had = into[key];
      if (had === undefined) {
        into[key] = structuredClone(value);
        setBy.set(here, id);
      } else if (isPlainObject(had) && isPlainObject(value)) merge(had, value, here, id);
      else if (Array.isArray(had) && Array.isArray(value)) into[key] = [...had, ...value.filter((v) => !had.some((h) => same(h, v))).map((v) => structuredClone(v))];
      else if (!same(had, value)) conflicts.push(`${owner(setBy, here)} and ${id} both set ${here} (${JSON.stringify(had)} and ${JSON.stringify(value)})`);
    }
  };
  const config = {};
  for (const b of blocks) merge(config, b.config, '', b.id);
  return { config, conflicts };
}

/** The block that first set `key`, or one of the keys above it. */
function owner(setBy, key) {
  for (let k = key; k; k = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : '') if (setBy.has(k)) return setBy.get(k);
  return 'another block';
}

/** The work types a block defines: a product block says what kinds of thing an item can deliver. */
export const typesOf = (block) => Object.keys(block.config.workTypes || {});

/**
 * The blocks that have words for a step about the work types `types`. A block that defines no
 * work type always speaks. One that does speaks when the step is about one of its types, or when
 * no block defines any of them (an item of the type "default": every block says for which items
 * its words hold).
 */
function speakers(blocks, types) {
  const about = new Set(types || []);
  const owners = blocks.filter((b) => typesOf(b).some((t) => about.has(t)));
  return blocks.filter((b) => !typesOf(b).length || !owners.length || owners.includes(b));
}

const fragmentFile = (block, name, variant) => {
  const exact = variant ? path.join(block.dir, 'prompts', `${name}.${variant}.md`) : '';
  return exact && fs.existsSync(exact) ? exact : path.join(block.dir, 'prompts', `${name}.md`);
};

/** Each block's words for `{{>name}}`, in stack order: [{ block, file, text }]. `variant`: `<name>.<variant>.md` wins over `<name>.md`. */
export function fragmentParts(blocks, name, { variant, types } = {}) {
  return speakers(blocks, types).map((b) => ({ block: b.id, file: fragmentFile(b, name, variant) })).filter((p) => fs.existsSync(p.file)).map((p) => ({ ...p, text: fs.readFileSync(p.file, 'utf8').trim() }));
}

/** The `{{>name}}` includes of a prompt, each once. */
export const includesOf = (template) => [...new Set([...template.matchAll(INCLUDE)].map((m) => m[1]))];

/** Whether any block has words for `{{>name}}`, in whatever variant. */
export function hasFragment(blocks, name) {
  return blocks.some((b) => {
    try {
      return fs.readdirSync(path.join(b.dir, 'prompts')).some((f) => f === `${name}.md` || (f.startsWith(`${name}.`) && f.endsWith('.md')));
    } catch {
      return false;
    }
  });
}

/**
 * A prompt with every `{{>name}}` replaced by the blocks' words for it, one block after the other.
 * The words are written flush left; here every line after the first gets the indentation of the
 * line the include stands on, so they sit in the list they are part of.
 *
 * `cases`: what the step is about, [{ variant, types, label }]. Mostly one: an item of one work
 * type. A milestone accepted in two places, or with two kinds of product, is several: each
 * include then gives the words for every case in turn, each under its `label`, so the session
 * does the step once per case. Throws when no block has words for an include in one of the cases.
 */
export function expandIncludes(template, blocks, { cases = [{}], where = 'the prompt' } = {}) {
  const none = (name, c) => {
    if (!blocks.length) return 'loop.config.json names no stack';
    const about = c.types?.length ? ` for ${c.types.map((t) => `"${t}"`).join(', ')} items` : '';
    return `no block of the stack (${blocks.map((b) => b.id).join(', ')}) has a prompts/${c.variant ? `${name}.${c.variant}.md or ${name}.md` : `${name}.md`}${about}`;
  };
  return template.replace(/^([ \t]*).*$/gm, (line, indent) =>
    line.replace(INCLUDE, (_, name) => {
      const words = cases.map((c) => {
        const parts = fragmentParts(blocks, name, c);
        if (!parts.length) throw new Error(`${where} includes {{>${name}}}, but ${none(name, c)}`);
        return [...(cases.length > 1 && c.label ? [c.label] : []), ...parts.map((p) => p.text)].join('\n');
      });
      return words.join('\n').replace(/\n(?=[^\r\n])/g, `\n${indent}`);
    }),
  );
}
