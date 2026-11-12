// Every core guard rule gets a block case and an allow case. The last block spawns the real hook
// the way Claude Code does: JSON on stdin, exit 2 to refuse.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from '../guard/core.mjs';
import { repoRelative, globToRegExp } from '../guard/paths.mjs';
import { compileRules } from '../guard/rules.mjs';
import { DEFAULTS, deepMerge } from '../lib/config.mjs';
import { PRESET } from './helpers/preset.mjs';

const LOOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';
const cfg = deepMerge(PRESET, { repo: 'acme/app', guard: { allowedDbProject: 'allowedref000000000a', forbiddenRefs: ['forbiddenref00000000z'] } });

function ctx(over = {}) {
  return {
    phase: 'build',
    item: 'T1',
    branch: 'feat/x',
    cfg,
    rel: (p) => repoRelative(ROOT, p),
    isOnBase: (rel) => (over.onBase || []).includes(rel),
    projectRules: over.projectRules || [],
    ...over,
  };
}
const sh = (command, c) => decide({ tool_name: 'Bash', tool_input: { command } }, ctx(c));
const edit = (file_path, c) => decide({ tool_name: 'Write', tool_input: { file_path, content: '' } }, ctx(c));
const mcp = (tool, input, c) => decide({ tool_name: tool, tool_input: input }, ctx(c));
const blocked = (d, rule) => {
  assert.equal(d.block, true, `expected a block, got ${JSON.stringify(d)}`);
  if (rule) assert.equal(d.rule, rule);
};
const allowed = (d) => assert.equal(d.block, false, `expected allow, got ${JSON.stringify(d)}`);

describe('shell rules', () => {
  const cases = [
    ['core:bypass', 'claude -p x --dangerously-skip-permissions', 'claude --version'],
    ['core:db-apply', 'supabase db push --db-url x', 'supabase migration new add_table'],
    ['core:force-push', 'git push --force origin feat/x', 'git push -u origin feat/x'],
    ['core:force-push', 'git push origin +feat/x', 'git push origin feat/x'],
    ['core:push-base', 'git push origin develop', 'git push origin feat/develop-docs'],
    ['core:push-base', 'git push origin HEAD:main', 'git push origin HEAD:feat/main-menu'],
    ['core:merge', 'gh pr merge 12 --squash', 'gh pr view 12'],
    ['core:repo-admin', 'gh secret set X', 'gh repo view'],
    ['core:gh-api-write', 'gh api -X DELETE repos/acme/app/git/refs/heads/x', 'gh api repos/acme/app/pulls'],
    ['core:gh-api-write', 'gh api repos/acme/app/branches/develop/protection', 'gh api repos/acme/app/commits/abc/check-runs'],
    ['core:vercel-write', 'npx vercel env add X', 'npx vercel ls'],
    ['core:broad-delete', 'rm -rf .', 'rm -rf .loop/review-wt'],
    ['core:git-destroy', 'git clean -fdx', 'git clean -n'],
    ['core:add-all', 'git add -A', 'git add src/app/page.tsx'],
    ['core:add-all', 'git add .', 'git add ./src'],
    ['core:forbidden-ref', 'curl https://forbiddenref00000000z.supabase.co', 'curl https://allowedref000000000a.supabase.co'],
    ['core:protected-path', 'sed -i s/a/b/ loop/run.mjs', 'cat loop/run.mjs'],
    ['core:protected-path', 'echo x > .github/workflows/ci.yml', 'echo x > notes.txt'],
  ];
  for (const [rule, bad, good] of cases) {
    test(`${rule}: blocks "${bad}", allows "${good}"`, () => {
      blocked(sh(bad), rule);
      allowed(sh(good));
    });
  }
  test('push and commit on the base branch are blocked', () => {
    blocked(sh('git push', { branch: 'develop' }), 'core:push-base');
    blocked(sh('git commit -m x', { branch: 'main' }), 'core:commit-base');
    allowed(sh('git commit -m x', { branch: 'feat/a' }));
  });
  test('a custom base name is protected too', () => {
    const c = { cfg: deepMerge(cfg, { base: 'trunk' }) };
    blocked(sh('git push origin trunk', c), 'core:push-base');
    allowed(sh('git push origin develop-notes', c));
  });
  test('read-only phases cannot commit, push or change PRs', () => {
    for (const phase of ['review', 'accept', 'packet']) {
      blocked(sh('git commit -m x', { phase }), 'core:read-only');
      blocked(sh('gh pr edit 3 --title x', { phase }), 'core:read-only');
      allowed(sh('gh pr review 3 --comment --body-file .loop/review-body.md', { phase }));
      allowed(sh('git worktree add .loop/review-wt origin/feat/x', { phase }));
    }
  });
});

describe('edit rules', () => {
  const p = (rel) => path.join(ROOT, rel);
  test('the runner, guard and CI are protected, Windows paths included', () => {
    blocked(edit(p('loop/run.mjs')), 'core:protected-path');
    blocked(edit(ROOT + '\\loop\\guard\\core.mjs'.replace(/\\/g, path.sep)), 'core:protected-path');
    blocked(edit(p('.github/workflows/ci.yml')), 'core:protected-path');
    blocked(edit(p('.claude/settings.json')), 'core:protected-path');
    allowed(edit(p('src/app/page.tsx')));
  });
  test('the guard snapshot and runner state are protected, other runtime files are not', () => {
    blocked(edit(p('.loop/guard/loop/guard.mjs')), 'core:protected-path');
    blocked(edit(p('.loop/state.json')), 'core:protected-path');
    allowed(edit(p('.loop/result.json')));
  });
  test('the rule table and a new runner patch may be written', () => {
    allowed(edit(p('loop/rules/project-rules.json')));
    allowed(edit(p('loop/patches/LEARN-3-retry.patch')));
    blocked(edit(p('loop/patches/LEARN-1.patch'), { onBase: ['loop/patches/LEARN-1.patch'] }), 'core:patch-frozen');
  });
  test('.env files are protected, .env.example is not', () => {
    blocked(edit(p('.env.local')), 'core:protected-path');
    blocked(edit(p('apps/web/.env')), 'core:protected-path');
    allowed(edit(p('.env.example')));
  });
  test('a migration already on base is frozen, a new one is not', () => {
    const rel = 'supabase/migrations/20260101000000_init.sql';
    blocked(edit(p(rel), { onBase: [rel] }), 'core:frozen-migration');
    allowed(edit(p('supabase/migrations/20260202000000_next.sql'), { onBase: [rel] }));
  });
  test('read-only phases may only write under .loop/', () => {
    blocked(edit(p('src/x.ts'), { phase: 'review' }), 'core:read-only');
    allowed(edit(p('.loop/review-body.md'), { phase: 'review' }));
  });
  test('files outside the repository are allowed in a build step', () => {
    allowed(edit(path.join(os.tmpdir(), 'scratch.txt')));
  });
});

describe('MCP rules', () => {
  const sql = 'mcp__supabase__execute_sql';
  test('only the configured project', () => {
    blocked(mcp(sql, { project_id: 'otherref', query: 'select 1' }), 'core:db-project');
    allowed(mcp(sql, { project_id: 'allowedref000000000a', query: 'select 1' }));
  });
  test('a forbidden ref anywhere in the input', () => {
    blocked(mcp('mcp__supabase__list_tables', { project_id: 'forbiddenref00000000z' }), 'core:forbidden-ref');
  });
  test('apply_migration and admin tools are blocked', () => {
    blocked(mcp('mcp__supabase__apply_migration', { project_id: 'allowedref000000000a' }), 'core:apply-migration');
    blocked(mcp('mcp__supabase__create_branch', { project_id: 'allowedref000000000a' }), 'core:db-admin');
  });
  test('agent SQL is read-only', () => {
    blocked(mcp(sql, { project_id: 'allowedref000000000a', query: 'insert into public.x values (1)' }), 'core:sql');
  });
  test('Vercel tools may read, not write', () => {
    blocked(mcp('mcp__vercel__create_project_env', {}), 'core:vercel-write');
    allowed(mcp('mcp__vercel__get_deployment', {}));
  });
  test('with no project configured, every Supabase call with a project is blocked', () => {
    const c = { cfg: deepMerge(PRESET, {}) };
    blocked(mcp(sql, { project_id: 'anything', query: 'select 1' }, c), 'core:db-project');
  });
});

describe('project rules add blocks', () => {
  const rules = compileRules({ rules: [{ id: 'P-1', target: 'shell', pattern: '\\bdocker\\s+run\\b', reason: 'no docker here', examples: { block: 'docker run x', allow: 'docker ps' } }] });
  test('a project rule blocks its example and allows the other', () => {
    blocked(sh('docker run x', { projectRules: rules }), 'P-1');
    allowed(sh('docker ps', { projectRules: rules }));
  });
  test('a project rule cannot unblock a core rule', () => {
    blocked(sh('git push origin develop', { projectRules: rules }), 'core:push-base');
  });
});

describe('paths', () => {
  test('globs', () => {
    assert.ok(globToRegExp('loop/**').test('loop/lib/x.mjs'));
    assert.ok(globToRegExp('.env*').test('apps/web/.env.local'));
    assert.ok(!globToRegExp('loop/**').test('src/loop/x'));
  });
  test('paths outside the repo are null', () => {
    assert.equal(repoRelative(ROOT, path.join(ROOT, '..', 'other', 'x')), null);
    assert.equal(repoRelative(ROOT, 'src/a.ts'), 'src/a.ts');
  });
});

describe('the real hook', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-guard-'));
  fs.mkdirSync(path.join(repo, 'loop'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'loop', 'loop.config.json'), JSON.stringify({ repo: 'acme/app' }));
  spawnSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: repo });
  const log = path.join(repo, '.loop', 'logs', 'guard.log');
  const run = (event, env = {}) => spawnSync(process.execPath, [path.join(LOOP, 'guard.mjs')], { cwd: repo, input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8', env: { ...process.env, LOOP_ROOT: repo, LOOP_PHASE: 'build', LOOP_ITEM: 'T9', LOOP_GUARD_LOG: log, ...env } });

  test('blocks with exit 2 and logs the rule', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 3' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /core:merge/);
    assert.match(fs.readFileSync(log, 'utf8'), /\tT9\tbuild\tcore:merge\t/);
  });
  test('allows with exit 0', () => {
    assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git status' } }).status, 0);
  });
  test('an unreadable payload is refused (fail closed)', () => {
    const r = run('{ not json');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /core:unreadable/);
  });
  test('a broken rule table makes the guard refuse, not allow', () => {
    fs.mkdirSync(path.join(repo, 'loop', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'loop', 'rules', 'project-rules.json'), '{ "rules": [{ "id": "P-x", "target": "shell", "pattern": "(", "reason": "r" }] }');
    const r = run({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /core:guard-error/);
    fs.rmSync(path.join(repo, 'loop', 'rules'), { recursive: true });
  });
});

describe('spellings that used to slip past (adversarial review)', () => {
  const bad = [
    ['core:push-base', 'git push origin "HEAD:develop"'],
    ['core:push-base', "git push origin 'develop'"],
    ['core:push-base', 'git -C . push origin HEAD:develop'],
    ['core:push-base', 'git -c core.x=y push origin develop'],
    ['core:git-config', 'git config push.default upstream'],
    ['core:git-config', 'git remote set-url origin https://example.com/x.git'],
    ['core:merge', 'gh pr -R acme/app merge 5'],
    ['core:merge', 'gh pr merge --repo=acme/app 5'],
    ['core:gh-api-write', 'gh api --method=PUT repos/acme/app/pulls/5/merge'],
    ['core:gh-api-write', 'gh api -XPUT repos/acme/app/pulls/5/merge'],
    ['core:gh-api-write', 'gh api graphql -f query="mutation { mergePullRequest(input:{}) { clientMutationId } }"'],
    ['core:push-base', 'git push --all origin'],
  ];
  for (const [rule, cmd] of bad) test(`${rule}: ${cmd}`, () => blocked(sh(cmd), rule));
  test('read-only phases cannot write through the shell', () => {
    for (const cmd of ['echo hi > src/app/page.tsx', 'sed -i s/a/b/ src/x.ts', 'git -C . commit -m x', 'git checkout -- src/x.ts']) blocked(sh(cmd, { phase: 'review' }), 'core:read-only');
    for (const cmd of ['pnpm build > .loop/build.log 2>&1', 'node x.mjs 2>&1', 'pnpm test > /dev/null', 'git diff origin/develop...origin/feat/x']) allowed(sh(cmd, { phase: 'review' }));
  });
  test('ordinary feature-branch work stays allowed', () => {
    for (const cmd of ['git push -u origin feat/a', 'git -C .loop/review-wt status', 'gh pr create --base develop --title "x" --body-file .loop/pr.md', 'gh api repos/acme/app/pulls/5', 'git config user.name']) allowed(sh(cmd));
  });
});

describe('guard packs', () => {
  const core = { cfg: deepMerge(DEFAULTS, { repo: 'acme/app', guard: { packs: [] } }) };
  test('with no pack listed, the core alone decides: tool rules are off, git rules stay', () => {
    allowed(sh('gh pr merge 5 --squash', core));
    allowed(sh('supabase db push', core));
    allowed(sh('vercel env pull', core));
    allowed(mcp('mcp__supabase__apply_migration', { name: 'x', query: 'create table t ()' }, core));
    allowed(mcp('mcp__vercel__create_deployment', {}, core));
    blocked(sh('git push --force origin feat/x', core), 'core:force-push');
    blocked(sh('git add -A', core), 'core:add-all');
    blocked(edit('loop/run.mjs', core), 'core:protected-path');
  });
  test('each pack switches its own rules on, and only those', () => {
    const only = (packs) => ({ cfg: deepMerge(DEFAULTS, { repo: 'acme/app', guard: { packs, allowedDbProject: 'allowedref000000000a' } }) });
    blocked(sh('gh pr merge 5 --squash', only(['github'])), 'core:merge');
    allowed(sh('supabase db push', only(['github'])));
    blocked(sh('supabase db push', only(['supabase'])), 'core:db-apply');
    blocked(mcp('mcp__supabase__execute_sql', { project_id: 'allowedref000000000a', query: 'delete from t' }, only(['supabase'])), 'core:sql');
    allowed(sh('gh pr merge 5 --squash', only(['supabase'])));
    blocked(mcp('mcp__vercel__create_deployment', {}, only(['vercel'])), 'core:vercel-write');
    allowed(mcp('mcp__vercel__list_deployments', {}, only(['vercel'])));
  });
  test('an unknown pack name fails closed', () => {
    assert.throws(() => sh('ls', { cfg: deepMerge(DEFAULTS, { guard: { packs: ['nope'] } }) }), /unknown guard pack "nope"/);
  });
  test('the real hook refuses every call when the config names an unknown pack', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-pack-'));
    const cfgFile = path.join(dir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(deepMerge(DEFAULTS, { guard: { packs: ['nope'] } })));
    const r = spawnSync(process.execPath, [path.join(LOOP, 'guard.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir }), encoding: 'utf8', env: { ...process.env, LOOP_ROOT: dir, LOOP_GUARD_CONFIG: cfgFile, LOOP_GUARD_LOG: path.join(dir, 'guard.log') } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /core:guard-error.*unknown guard pack/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('a shell line that only names a harness path reads it', () => {
  // Every line here was refused in a real run, and each refusal counted towards a LEARN item.
  const reads = [
    'grep -nE "run:|name:" .github/workflows/*.yml | head -40; npm run check >/tmp/check.log 2>&1; echo "check=$?"',
    'node --test loop/test/guard-core.test.mjs 2>&1 | tail -12',
    'cat loop/prompts/learn.md && ls loop/patches 2>/dev/null',
    'git apply --check .loop/tmp/x.patch; grep -n "patch" loop/README.md > .loop/tmp/hits.txt',
    'cp loop/guard/core.mjs .loop/tmp/core-copy.mjs',
    'cp "loop/guard/core.mjs" .loop/tmp/core-copy.mjs',
    "gh pr create --title t --body \"$(cat <<'EOF'\nThe guard read `loop/` -> refused; rm nothing, cp nothing.\nEOF\n)\"",
    "git commit -m \"$(cat <<'EOF'\nfix: loop/ reads; mv none > all\nEOF\n)\"",
    'T=$(ls -d loop/test)/guard-core.test.mjs; node --test "$T" 2>&1 | tail -12',
    'npm test 2>&1 | tee .loop/tmp/out.txt; cat loop/README.md',
    "echo 'x' ; cat <<'EOF' > .loop/tmp/b.md\nrm loop/run.mjs is only text\nEOF",
    'cd .loop/tmp/wt && node --test ../../../loop/test/guard-core.test.mjs 2>&1 | tail -5',
    "grep -c 'a;b' loop/run.mjs # don't worry\necho done > .loop/tmp/n.txt",
    'curl -s https://example.com/page#top > .loop/tmp/page.html; cat loop/README.md',
    'git log --format="%H %ae>" -3 -- loop/run.mjs',
    'mkdir -p loop/patches && git diff > loop/patches/LEARN-9-new.patch',
    "mkdir -p .loop/tmp && cat <<'EOF' > .loop/tmp/body.md\n## What\nThe guard read `loop/` and refused; rm nothing, mv nothing.\n- `.github/workflows/ci.yml` -> unchanged\nEOF\necho done",
    'cat docs/LESSONS.md | grep -c "loop/" > .loop/tmp/n.txt',
  ];
  for (const line of reads) test(`allows: ${line.split('\n')[0].slice(0, 80)}`, () => allowed(sh(line)));

  const writes = [
    'echo x > loop/run.mjs',
    'echo x >> .github/workflows/ci.yml',
    'echo x >loop/run.mjs',
    'echo x 1> loop/run.mjs',
    'node build.mjs &> loop/run.mjs',
    'echo x >| loop/run.mjs',
    'echo x > "loop/run.mjs"',
    'cat a.txt | tee loop/run.mjs',
    'cp a.txt loop/run.mjs',
    'cp -t loop/lib a.mjs',
    'mv loop/run.mjs loop/run.old',
    'rm loop/guard/core.mjs',
    'touch .claude/settings.json',
    'sed -i s/a/b/ loop/run.mjs',
    'git checkout -- loop/run.mjs',
    'rm -rf loop',
    'cp <(rm loop/run.mjs) .loop/tmp/copy.txt',
    'cp a.txt loop/run.mjs -v',
    'cp a.txt loop/run.mjs 2>/dev/null',
    'Copy-Item -Destination loop/run.mjs -Path a.txt',
    'ln -sf a.txt loop/run.mjs',
    'X=1 cp a.txt loop/run.mjs',
    'bash -c "cp a.txt loop/run.mjs; echo done"',
    'cp "$(rm .loop/state.json; echo source.txt)" .loop/tmp/copy.txt',
    'cp `rm loop/run.mjs; echo a.txt` .loop/tmp/copy.txt',
    'cp $(echo a.txt > loop/run.mjs) .loop/tmp/copy.txt',
    'ls "$(rm loop/run.mjs)"',
    'echo "$(cd loop && rm run.mjs)"',
    'F=loop/run.mjs; rm "$F"',
    'ls loop/*.mjs | xargs rm',
    'dd if=/dev/null of=loop/run.mjs',
    'cd docs && echo x > ../loop/run.mjs',
    'cd "$D" && echo x > run.mjs; ls loop',
    'cat loop/run.mjs; echo x > ~/elsewhere/run.mjs',
    'cat <<< "EOF"\nrm loop/run.mjs\nEOF',
    '# see <<EOF\nrm loop/run.mjs\nEOF',
    'echo $((a << b))\nrm loop/run.mjs\nb',
    'echo ${x/ #/}; rm loop/run.mjs',
    'cp a.txt loop/run.mjs # note',
    'cat `echo <<EOF`\nrm loop/run.mjs\nEOF',
    "# don't\nrm .loop/state.json; echo done",
    "echo 'never closed\nrm .loop/state.json; echo done",
    "echo 'never closed; cp a.txt loop/run.mjs; echo x",
    'echo ok # a note\nrm loop/run.mjs',
    "sed -i 's/foo/bar/;s/baz/qux/' loop/run.mjs",
    'sed -i "s/foo/bar/;s/baz/qux/" loop/run.mjs',
    "perl -pi -e 's/a/b/ && 1' loop/run.mjs",
    "# don't touch the tree\ncd loop; echo x > run.mjs # that's it",
    "# don't\ncp a.txt loop/run.mjs; echo 'done'",
    "echo 'a|b' | tee loop/run.mjs",
    'pwd\ncd loop/lib; echo x > engine.mjs',
    'cp /tmp/replacement loop/run.mjs\necho done',
    'cat <<EOF > /tmp/body\n$(rm loop/run.mjs)\nEOF',
    'cat <<EOF > /tmp/body\n`rm loop/run.mjs`\nEOF',
    "cat <<'EOF' > /tmp/body\ntext\nNOT-THE-END\nrm loop/run.mjs",
    'cp a.txt \\\n  loop/run.mjs',
    'echo x > .claude/skills/a/SKILL.md',
    'cd loop && echo x > run.mjs',
    'cd loop; sed -i s/a/b/ run.mjs',
    'D=loop; echo x > "$D/run.mjs"',
    'ls docs; echo ok && echo x > loop/run.mjs',
    "cat <<'EOF' > loop/run.mjs\nexport {}\nEOF",
    "bash <<'EOF'\necho x > loop/run.mjs\nEOF",
    "echo 'a << EOF'\nrm loop/run.mjs\necho EOF",
    "cat <<'EOF' > .loop/tmp/a.txt\ntext\nEOF\nrm loop/run.mjs",
  ];
  for (const line of writes) test(`blocks: ${line.replace(/\n/g, ' ⏎ ').slice(0, 80)}`, () => blocked(sh(line), 'core:protected-path'));

  test('a patch that is already on the base branch is not rewritten by a redirect', () => {
    blocked(sh('git diff > loop/patches/LEARN-1.patch', { onBase: ['loop/patches/LEARN-1.patch'] }), 'core:protected-path');
    blocked(sh('git apply loop/patches/LEARN-1.patch', { onBase: ['loop/patches/LEARN-1.patch'] }), 'core:protected-path');
  });
});
