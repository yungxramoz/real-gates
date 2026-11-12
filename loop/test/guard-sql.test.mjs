// The SQL rules of the loop guard. Ported from the original run, where a schema-qualifier rule read
// "public. Kept" inside a SQL comment as a write and refused a valid migration. These pin both halves:
// comments are ignored, and a comment can neither hide a write nor smuggle one past the guard.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SQL_BLOCK_REASONS as R, sqlBlockReason, stripSqlComments } from '../guard/packs/postgres-sql.mjs';

const W = { allowWrite: true, schema: 'app' }; // a session allowed to write, app schema only

describe('stripSqlComments', () => {
  test('replaces a line comment with a space and keeps the line break', () => {
    assert.equal(stripSqlComments('select 1; -- the public. thing\nselect 2;'), 'select 1;  \nselect 2;');
  });
  test('ends a line comment at \\r as well, as Postgres does', () => {
    assert.equal(stripSqlComments('-- note\rinsert into t values (1)'), ' \rinsert into t values (1)');
  });
  test('removes block comments, nested ones included', () => {
    assert.equal(stripSqlComments('select /* a /* b */ still comment */ 1'), 'select   1');
  });
  test('leaves -- and /* inside string literals, E-strings and quoted identifiers alone', () => {
    const sql = `select '-- no', 'it''s /* no */', E'\\' -- no', "a--b" from t`;
    assert.equal(stripSqlComments(sql), sql);
  });
  test('removes a comment inside a dollar-quoted body but stops at the closing tag', () => {
    assert.equal(stripSqlComments('as $$ begin -- note\n return; end $$;'), 'as $$ begin  \n return; end $$;');
    assert.equal(stripSqlComments('select $$ -- $$; insert into t'), 'select $$  $$; insert into t');
    assert.equal(stripSqlComments('select $q$ -- $$ $q$; x'), 'select $q$  $q$; x');
  });
  test('keeps the rest verbatim after an unterminated comment, string or dollar quote', () => {
    assert.equal(stripSqlComments('select 1 /* open'), 'select 1 /* open');
    assert.equal(stripSqlComments("select 'open -- x"), "select 'open -- x");
    assert.equal(stripSqlComments('select $$ open -- x'), 'select $$ open -- x');
  });
  test('treats $ inside an identifier or a parameter as plain text', () => {
    assert.equal(stripSqlComments('select a$b$ -- c\n, $1 -- d\n'), 'select a$b$  \n, $1  \n');
  });
});

describe('a comment does not trip the rules', () => {
  const migration = `-- The first time a row goes public. Kept on unpublish.\ncreate table app.t (id int);\nalter table app.t enable row level security;`;
  test('a write in the app schema with "public." in a comment is allowed for a writing session', () => {
    assert.equal(sqlBlockReason(migration, W), null);
  });
  test('the same file is refused for an agent session (read-only)', () => {
    assert.equal(sqlBlockReason(migration), R.readOnly);
  });
});

describe('writes outside the app schema stay blocked', () => {
  const statements = ['insert into public.x (a) values (1);', "update auth.users set email = 'a@example.com';", 'create table storage.y (id int);'];
  const framings = [
    ['plain', ''],
    ['after a line comment', '-- harmless note on the previous line\n'],
    ['after a \\r-ended line comment', '-- harmless note\r'],
    ['after a block comment', '/* harmless note */\n'],
  ];
  for (const statement of statements) {
    for (const [label, prefix] of framings) {
      test(`${statement} — ${label}`, () => assert.equal(sqlBlockReason(prefix + statement, W), R.foreignSchema));
    }
  }
  test('a quoted schema name is the same schema', () => {
    assert.equal(sqlBlockReason('insert into "public"."x" values (1)', W), R.foreignSchema);
    assert.equal(sqlBlockReason('update "auth" . users set x = 1', W), R.foreignSchema);
  });
  test('platform schemas are foreign even with no schema configured', () => {
    assert.equal(sqlBlockReason('update auth.users set x = 1', { allowWrite: true }), R.foreignSchema);
    assert.equal(sqlBlockReason('insert into public.x values (1)', { allowWrite: true }), null);
  });
  test('reads of other schemas stay allowed', () => {
    assert.equal(sqlBlockReason('select id, name from public.x where id = 1'), null);
    assert.equal(sqlBlockReason('-- what is there?\nselect count(*) from auth.users'), null);
  });
});

describe('a comment cannot smuggle a write past the guard', () => {
  const smuggled = [
    ['-- inside a string', "select '--'; insert into public.x values (1);"],
    ["'' inside a string", "select 'it''s -- fine'; update auth.users set x = 1;"],
    ["\\' inside an E-string", "select E'\\' -- '; insert into public.x values (1);"],
    ['-- inside a quoted identifier', 'select "a--b"; insert into public.x values (1);'],
    ['$$ closed after a --', 'select $$ -- $$; insert into public.x values (1);'],
    ['/* */ inside the words', 'insert/**/into public/**/./**/x values (1);'],
    ['a write in a dollar-quoted body', 'do $$ begin insert into public.x values (1); end $$;'],
    ['nested dollar quotes', 'do $a$ begin execute $b$ insert into public.x values (1) $b$; end $a$;'],
  ];
  for (const [label, sql] of smuggled) test(label, () => assert.equal(sqlBlockReason(sql, W), R.foreignSchema));

  test('a commented-out select does not make a write read-only', () => {
    assert.equal(sqlBlockReason('-- select 1\ninsert into app.t values (1)'), R.readOnly);
    assert.equal(sqlBlockReason('select 1 -- x\r; insert into app.t values (1)'), R.readOnly);
    assert.equal(sqlBlockReason('select 1 /* x */; delete from app.t where id = 1'), R.readOnly);
  });
});

describe('destructive SQL', () => {
  test('is blocked even for a writing session', () => {
    for (const sql of ['drop table app.x;', 'truncate app.x;', 'delete from app.x;', 'alter table app.x drop column y;']) {
      assert.equal(sqlBlockReason(sql, W), R.destructive, sql);
    }
  });
  test('an unbounded delete followed by a comment is caught', () => {
    assert.equal(sqlBlockReason('delete from app.x -- everything', W), R.destructive);
  });
  test('re-creating a function, policy or trigger is not destructive', () => {
    assert.equal(sqlBlockReason('drop function if exists app.f();', W), null);
    assert.equal(sqlBlockReason('drop policy if exists p on app.x;', W), null);
    assert.equal(sqlBlockReason('delete from app.x where id = 1;', W), null);
  });
  test('an empty query is refused for an agent', () => {
    assert.equal(sqlBlockReason(''), R.readOnly);
    assert.equal(sqlBlockReason(undefined), R.readOnly);
  });
});

test('a column type change counts as destructive', () => {
  assert.equal(sqlBlockReason('alter table app.t alter column n type text;', W), R.destructive);
  assert.equal(sqlBlockReason('alter table app.t alter column n set default 0;', W), null);
});
