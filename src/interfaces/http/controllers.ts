import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Container } from '../../bootstrap/container';
import { assertProviderAccess } from './auth/authenticator';
import { statusForResult } from './error-mapping';
import type { HttpRequest, HttpResponse } from './http-types';
import { CONTAINER, Public } from './nest-infrastructure';
import {
  parseCreateWalletBody,
  parseLimit,
  parseSubmitTransactionBody,
  requireIdempotencyKey,
} from './request-parsing';

/**
 * Controllers are thin adapters: parse shape → call ONE use case → map the result.
 * No business decision is taken here.
 */
@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: HttpRequest) {
    const input = parseCreateWalletBody(body);
    return this.c.createWallet.execute({ ...input, correlationId: req.correlationId });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.c.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.c.queries.getLedger(walletId, cursor || undefined, parseLimit(limit, 50));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string, @Req() req: HttpRequest) {
    return this.c.reconcileWallet.execute(walletId, req.correlationId);
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const input = parseSubmitTransactionBody(body);
    assertProviderAccess(req.principal, input.providerId);

    const { duplicateMessage: _ignored, ...result } = await this.c.submitWagerTransaction.execute({
      ...input,
      idempotencyKey: key,
      correlationId: req.correlationId,
    });
    res.status(statusForResult(result));
    if (result.idempotentReplay) res.setHeader('Idempotent-Replayed', 'true');
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string, @Req() req: HttpRequest) {
    const tx = await this.c.queries.getTransaction(transactionId);
    assertProviderAccess(req.principal, tx.providerId);
    return tx;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() req: HttpRequest,
  ) {
    assertProviderAccess(req.principal, providerId);
    return this.c.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  /** Liveness: the process is up and the event loop responds. No dependency checks. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: every dependency reachable (PostgreSQL, SQS). 503 otherwise. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: HttpResponse) {
    const checks = await Promise.all(
      this.c.healthIndicators.map(async (indicator) => {
        try {
          await indicator.check();
          return [indicator.name, { status: 'up' }] as const;
        } catch (error) {
          return [indicator.name, { status: 'down', error: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
    );
    const ready = checks.every(([, c]) => c.status === 'up');
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not-ready', checks: Object.fromEntries(checks) };
  }
}
