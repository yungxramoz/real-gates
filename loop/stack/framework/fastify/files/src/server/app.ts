import fs from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

export type AppOptions = {
  /** The folder of a built web app to serve beside the API. Left out, or not there: API only. */
  webRoot?: string;
};

/** The server, not yet listening: a test calls it with `inject`, `main.ts` opens the port. */
export async function buildApp({ webRoot }: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();

  app.get('/api/health', () => ({ status: 'ok' }));

  if (webRoot && fs.existsSync(path.join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(webRoot) });
  }

  return app;
}
