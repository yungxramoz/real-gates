// What the guard lets a read-only step do, in the words a session is given before it starts.
//
// A session used to learn these rules by being refused: most refusals of a run were review and
// acceptance sessions writing where they may not, or the right thing spelled a way the guard
// cannot read. Told up front, a session does it the allowed way the first time. Every line here is
// held to the real guard by loop/test/guard-core.test.mjs: a rule the guard does not have, or a
// way it would refuse, fails there.

/** Shell lines a read-only step may use, and the same intent spelled a way the guard refuses. */
export const READ_ONLY_WAYS = (work) => ({
  allowed: [
    `node bin/cli.mjs --help > ${work}/help.txt 2>&1`,
    `cd ${work} && npm test > test.txt 2>&1`,
    `printf 'a note\\n' >> ${work}/notes.txt`,
    `git worktree add ${work}/wt origin/feat/x`,
    `sed 's/a/b/' ${work}/wt/src/a.mjs > ${work}/a.new && cp ${work}/a.new ${work}/wt/src/a.mjs`,
    `cd ${work}/wt && npm test > ../mutation.txt 2>&1; echo "exit=$?"`,
    `git worktree remove --force ${work}/wt`,
    `rm -rf ${work}/tmp`,
  ],
  refused: [
    `OUT=${work}/out.txt; npm test > $OUT`,
    `cd ${work}; npm test > test.txt`,
    `npm test > test.txt`,
    `sed -i 's/a/b/' src/a.mjs`,
    `sed -i 's/a/b/' ${work}/wt/src/a.mjs`,
    `git -C ${work}/wt checkout -- src/a.mjs`,
    'git stash',
    'git commit -m x',
  ],
});

/** The paragraph a review, acceptance, packet or retro session reads. `work`: its working folder. */
export function readOnlyRules(work) {
  return [
    '**What the guard lets this step do.** A hook reads every shell line before it runs, so an unattended run stays safe. Its rules for a read-only step are these four. A refusal is the guard working: it is never a fault to report and never a reason to stop. Do the same thing the allowed way and carry on.',
    `- **Write only under \`.loop/\`**, best in your working folder. Name the target from the repository root (\`npm test > ${work}/test.txt 2>&1\`), or go there first on the same line with \`&&\` (\`cd ${work} && npm test > test.txt\`). A target in a variable (\`> $OUT/test.txt\`), after \`;\` or on a later line is refused: the guard cannot see where it lands.`,
    `- **Never change a file in place.** \`sed -i\`, \`perl -i\` and their like are refused everywhere, also on a copy. To try a change (a mutation test, a what-if), make a worktree in your folder (\`git worktree add ${work}/wt origin/<branch>\`), write the changed file through a redirect and copy it over (\`sed '…' ${work}/wt/src/a.mjs > ${work}/a.new && cp ${work}/a.new ${work}/wt/src/a.mjs\`), run what you want to see there, and remove the worktree afterwards. To undo a change, remove the worktree and add it again.`,
    '- **No commits, pushes, checkouts, stashes, branch or pull request changes**, in the repository or in a worktree. You report; the runner acts.',
    `- **Delete only inside your folder**, by its path from the repository root (\`rm -rf ${work}/tmp\`).`,
  ].join('\n');
}
