/**
 * Opt-in (needs Docker): `bun run test:docker`.
 * End-to-end with a REAL Keycloak (compose profile "auth", realm imported from
 * docker/keycloak): client-credentials tokens → our HTTP API in AUTH_MODE=oidc.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { loadConfig } from '../../src/bootstrap/config';
import { type Container, createContainer } from '../../src/bootstrap/container';
import { createHttpApp } from '../../src/interfaces/http/http-app';
import { createTestOrm, resetSchema, TEST_DATABASE_URL } from '../integration/support/db';

const enabled = process.env.RUN_DOCKER_TESTS === '1';
setDefaultTimeout(240_000);

const KEYCLOAK = 'http://localhost:8080/realms/wagering';
let container: Container;
let app: INestApplication;
let base: string;

async function clientToken(clientId: string): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: `${clientId}-secret` }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

describe.skipIf(!enabled)('real Keycloak (client credentials) → AUTH_MODE=oidc', () => {
  beforeAll(async () => {
    const compose = Bun.spawn(['docker', 'compose', '--profile', 'auth', 'up', '-d', '--wait', 'keycloak'], { stdout: 'ignore', stderr: 'pipe' });
    if ((await compose.exited) !== 0) throw new Error(await new Response(compose.stderr).text());
    const orm = await createTestOrm();
    await resetSchema(orm);
    await orm.close(true);
    container = await createContainer(
      loadConfig({ DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'silent', AUTH_MODE: 'oidc', OIDC_ISSUER: KEYCLOAK }),
    );
    app = await createHttpApp(container);
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await container?.close();
  });

  test('provider tokens are scoped to their provider; back-office is unrestricted; no token → 401', async () => {
    const [providerA, providerB, backoffice] = await Promise.all(['provider-a', 'provider-b', 'backoffice'].map(clientToken));
    const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

    expect((await fetch(`${base}/wallets/${randomUUID()}`)).status).toBe(401);

    const walletRes = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: auth(providerA!),
      body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(walletRes.status).toBe(201);
    const wallet = (await walletRes.json()) as { id: string; playerId: string };

    const body = (providerId: string) => ({
      providerId,
      externalTransactionId: `tx-${randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const submit = (token: string, b: ReturnType<typeof body>) =>
      fetch(`${base}/wagering/transactions`, {
        method: 'POST',
        headers: { ...auth(token), 'idempotency-key': `${b.providerId}:${b.externalTransactionId}` },
        body: JSON.stringify(b),
      });

    const ok = await submit(providerA!, body('provider-a'));
    expect(ok.status).toBe(200);
    const { transactionId } = (await ok.json()) as { transactionId: string };

    expect((await submit(providerA!, body('provider-b'))).status).toBe(403);
    expect((await fetch(`${base}/wagering/transactions/${transactionId}`, { headers: auth(providerB!) })).status).toBe(404);
    expect((await fetch(`${base}/wagering/transactions/${transactionId}`, { headers: auth(backoffice!) })).status).toBe(200);
  });
});
