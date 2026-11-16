/**
 * AUTH_MODE=oidc over real HTTP: real RSA keys, a real JWKS endpoint, tokens shaped like
 * Keycloak client-credentials tokens. (test/docker/keycloak.test.ts runs the same flow
 * against a real Keycloak.)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { loadConfig } from '../../src/bootstrap/config';
import { type Container, createContainer } from '../../src/bootstrap/container';
import { createHttpApp } from '../../src/interfaces/http/http-app';
import { createTestOrm, resetSchema, TEST_DATABASE_URL } from '../integration/support/db';

const ISSUER = 'http://idp.test/realms/wagering';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwksServer: ReturnType<typeof Bun.serve>;
let container: Container;
let app: INestApplication;
let base: string;

async function start(jwksUri: string) {
  const c = await createContainer(
    loadConfig({ DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'silent', AUTH_MODE: 'oidc', OIDC_ISSUER: ISSUER, OIDC_JWKS_URI: jwksUri }),
  );
  const a = await createHttpApp(c);
  await a.listen(0);
  return { c, a, base: `http://127.0.0.1:${(a.getHttpServer().address() as { port: number }).port}` };
}

beforeAll(async () => {
  const orm = await createTestOrm();
  await resetSchema(orm);
  await orm.close(true);
  keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  ({ c: container, a: app, base } = await start(`http://127.0.0.1:${jwksServer.port}/certs`));
});

afterAll(async () => {
  await app.close();
  await container.close();
  jwksServer.stop(true);
});

async function token(
  claims: JWTPayload,
  opts: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? 'wagering-api')
    .setSubject('service-account')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(opts.key ?? keys.privateKey);
}

const providerA = () => token({ provider_id: 'provider-a', azp: 'provider-a' });

async function call(path: string, init: { method?: string; body?: unknown; bearer?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text && text.startsWith('{') ? JSON.parse(text) : text };
}

async function walletAs(bearer: string) {
  const res = await call('/wallets', {
    method: 'POST',
    bearer,
    body: { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

function txBody(w: { id: string; playerId: string }, providerId: string) {
  return {
    providerId,
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'r-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
}

const submit = (bearer: string, body: ReturnType<typeof txBody>) =>
  call('/wagering/transactions', {
    method: 'POST',
    bearer,
    body,
    headers: { 'idempotency-key': `${body.providerId}:${body.externalTransactionId}` },
  });

describe('AUTH_MODE=oidc', () => {
  test('health and metrics stay public', async () => {
    expect((await call('/health/live')).status).toBe(200);
    expect((await call('/health/ready')).status).toBe(200);
    expect((await call('/metrics')).status).toBe(200);
  });

  test('401 without a bearer token, with WWW-Authenticate', async () => {
    const res = await call(`/wallets/${randomUUID()}`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
  });

  test.each([
    ['garbage', async () => 'not-a-jwt'],
    ['signed by another key', async () => token({ provider_id: 'provider-a' }, { key: (await generateKeyPair('RS256')).privateKey })],
    ['expired', async () => token({ provider_id: 'provider-a' }, { expiresIn: '-1m' })],
    ['wrong audience', async () => token({ provider_id: 'provider-a' }, { audience: 'account' })],
    ['wrong issuer', async () => token({ provider_id: 'provider-a' }, { issuer: 'http://evil/realms/wagering' })],
  ])('401 for a %s token', async (_, make) => {
    expect((await call(`/wallets/${randomUUID()}`, { bearer: await make() })).status).toBe(401);
  });

  test('a provider can only act for itself (403 otherwise, nothing persisted)', async () => {
    const bearer = await providerA();
    const w = await walletAs(bearer);
    expect((await submit(bearer, txBody(w, 'provider-a'))).status).toBe(200);

    const foreign = txBody(w, 'provider-b');
    const res = await submit(bearer, foreign);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROVIDER_FORBIDDEN');
    const back = await call(`/providers/provider-b/wagering/transactions/${foreign.externalTransactionId}`, {
      bearer: await token({ provider_id: 'provider-b' }),
    });
    expect(back.status).toBe(404); // never written

    // token without any provider claim: authenticated, but may act for nobody
    expect((await submit(await token({}), txBody(w, 'provider-a'))).status).toBe(403);
  });

  test("another provider's transaction is invisible (404, not 403); back-office sees everything", async () => {
    const bearerA = await providerA();
    const w = await walletAs(bearerA);
    const body = txBody(w, 'provider-a');
    const { body: result } = await submit(bearerA, body);

    const bearerB = await token({ provider_id: 'provider-b' });
    expect((await call(`/wagering/transactions/${result.transactionId}`, { bearer: bearerB })).status).toBe(404);
    expect((await call(`/providers/provider-a/wagering/transactions/${body.externalTransactionId}`, { bearer: bearerB })).status).toBe(403);

    const backoffice = await token({ realm_access: { roles: ['wagering-backoffice'] } });
    expect((await call(`/wagering/transactions/${result.transactionId}`, { bearer: backoffice })).status).toBe(200);
  });

  test('identity provider unreachable → 503 retryable (not a 401)', async () => {
    const down = await start('http://127.0.0.1:1/certs');
    try {
      const res = await fetch(`${down.base}/wallets/${randomUUID()}`, { headers: { authorization: `Bearer ${await providerA()}` } });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { retryable: boolean } }).error.retryable).toBe(true);
    } finally {
      await down.a.close();
      await down.c.close();
    }
  });
});

describe('trial balance authorization', () => {
  test('provider tokens cannot read the house book; back-office can', async () => {
    expect((await call('/ledger/trial-balance', { bearer: await providerA() })).status).toBe(403);
    const backoffice = await token({ realm_access: { roles: ['wagering-backoffice'] } });
    const res = await call('/ledger/trial-balance', { bearer: backoffice });
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
  });
});
