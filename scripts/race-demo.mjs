// Fires 20 identical requests at once at both endpoints and prints what happened.
// Start the API first (npm run start:dev), then: npm run demo:race
import { randomUUID } from 'node:crypto';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
const N = 20;
const ref = 'SF-' + Date.now();

async function fire(path, headers = {}) {
  const res = await Promise.all(
    Array.from({ length: N }, () =>
      fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ externalRef: ref + path.replace(/\W/g, ''), total: 49.99 }),
      }).then(async (r) => ({ status: r.status, replayed: r.headers.get('idempotent-replayed'), body: await r.json() })),
    ),
  );
  const ids = new Set(res.map((r) => r.body.id));
  return { ids: ids.size, replayed: res.filter((r) => r.replayed).length, statuses: [...new Set(res.map((r) => r.status))] };
}

const naive = await fire('/orders/naive');
console.log(`naive       : ${N} requests → ${naive.ids} different orders created   ${naive.ids > 1 ? '❌ duplicates' : '(no race this run, try again)'}`);

const safe = await fire('/orders', { 'Idempotency-Key': randomUUID() });
console.log(`idempotent  : ${N} requests → ${safe.ids} order created, ${safe.replayed} replayed responses   ${safe.ids === 1 ? '✅' : '❌'}`);
