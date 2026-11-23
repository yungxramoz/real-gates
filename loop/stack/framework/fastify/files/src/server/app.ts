import fs from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

export type AppOptions = {
  /** The folder of a built web app to serve beside the API. Left out, or not there: API only. */
  webRoot?: string;
  /** The commit this build was made from, as the host names it. Left out: `unknown`. */
  commit?: string;
};

/** The server, not yet listening: a test calls it with `inject`, `main.ts` opens the port. */
export async function buildApp({ webRoot, commit }: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();

  // Whoever waits for a deployment reads `commit`: it tells that this build is the one that runs.
  app.get('/api/health', () => ({ status: 'ok', commit: commit || 'unknown' }));

  if (webRoot && fs.existsSync(path.join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(webRoot) });
  }

  return app;
}
