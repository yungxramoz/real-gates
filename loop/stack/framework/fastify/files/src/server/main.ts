import { buildApp } from './app.ts';

// The web app, when the project has one and it was built (`pnpm build`), is served from here too.
const app = await buildApp({ webRoot: 'dist' });
const port = Number(process.env.PORT) || 3000;
// Local only: nothing outside this machine reaches the server unless HOST says so.
const host = process.env.HOST || '127.0.0.1';

try {
  const address = await app.listen({ port, host });
  console.log(`listening on ${address}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
