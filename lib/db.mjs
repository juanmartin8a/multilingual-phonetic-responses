import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function connect(cfg) {
  const require = createRequire(resolve(cfg.project, 'package.json'));
  const { ConvexHttpClient } = require('convex/browser');
  const { makeFunctionReference } = require('convex/server');
  const client = new ConvexHttpClient(cfg.identity.url, {
    fetch: (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) }),
  });
  client.setAdminAuth(cfg.identity.key);
  async function call(kind, name, args) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client[kind](makeFunctionReference(`phoneticPopulation:${name}`),
          { expectedUrl: cfg.identity.url, ...args });
      } catch (error) {
        // Backend validation/auth errors aren't retried. Network errors and
        // server availability errors are; every mutation here is atomic/idempotent.
        if (attempt >= 2 || !/fetch failed|network|timeout|\b50[234]\b/i.test(error.message)) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  return {
    languages: () => call('query', 'languages', {}),
    page: (args) => call('query', 'page', args),
    insertTranscriptions: (rows) => call('mutation', 'insertTranscriptions', { rows }),
    insertRespellings: (rows) => call('mutation', 'insertRespellings', { rows }),
  };
}
