import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { buildApp } from './app.ts';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

test('the health endpoint answers', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok', commit: 'unknown' });
});

test('the health endpoint names the commit the build was made from', async () => {
  const app = await buildApp({ commit: '0123abc' });
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.json()).toEqual({ status: 'ok', commit: '0123abc' });
});

test('an unknown route is a 404, with or without a web app', async () => {
  const app = await buildApp({ webRoot: path.join(os.tmpdir(), 'no-such-folder') });
  expect((await app.inject({ method: 'GET', url: '/api/nothing' })).statusCode).toBe(404);
});

test('a built web app is served beside the API', async () => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  folders.push(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>App</title>');
  const app = await buildApp({ webRoot });
  const page = await app.inject({ method: 'GET', url: '/' });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('<title>App</title>');
  expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
});
