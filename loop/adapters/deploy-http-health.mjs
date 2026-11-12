// Deploy adapter: a site that reports which commit it serves on a health endpoint.
//
// Milestone acceptance must test what was merged, not an older deployment. So before it starts,
// the runner polls `deploy.devUrl + deploy.health` until the JSON body's commit field
// (`deploy.commitField`, default "commit") starts with the merged sha and every field in
// `deploy.expect` has one of its allowed values (the preset: { "db": ["ok", "stub"] }).
//
// A deployment behind preview protection: `deploy.bypassHeader` names the request header and
// `deploy.bypassSecretEnv` the environment variable that holds its value.
//
// The deploy interface: name, waitUntilServing(ctx, sha) -> { ok: true } | { ok: false, why }.

export const name = 'http-health';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntilServing(L, sha) {
  const d = L.cfg.deploy || {};
  if (!d.devUrl) return { ok: false, why: 'deploy.devUrl is not set' };
  const url = d.devUrl.replace(/\/$/, '') + (d.health || '/api/health');
  const headers = {};
  const bypass = d.bypassHeader && d.bypassSecretEnv && L.envBase[d.bypassSecretEnv];
  if (bypass) headers[d.bypassHeader] = bypass;
  const commitField = d.commitField || 'commit';
  const expect = Object.entries(d.expect || {});
  const deadline = Date.now() + (L.cfg.timeouts.deployMin ?? 20) * 60_000;
  let last = '';
  for (;;) {
    if (L.stopRequested()) return { ok: false, why: 'stopped' };
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      const body = await res.json().catch(() => ({}));
      last = [`HTTP ${res.status}`, `${commitField} ${body[commitField] ?? '?'}`, ...expect.map(([k]) => `${k} ${body[k] ?? '?'}`)].join(', ');
      const healthy = expect.every(([k, allowed]) => [].concat(allowed).includes(body[k]));
      if (res.ok && String(body[commitField] || '').startsWith(sha.slice(0, 7)) && healthy) return { ok: true };
    } catch (e) {
      last = String(e.message || e);
    }
    if (Date.now() > deadline) return { ok: false, why: `${url} never served ${sha.slice(0, 7)}${expect.length ? ` with ${expect.map(([k, a]) => `${k} ${[].concat(a).join('|')}`).join(', ')}` : ''} (last: ${last})` };
    await sleep(L.cfg.pollMs ?? 30_000);
  }
}
