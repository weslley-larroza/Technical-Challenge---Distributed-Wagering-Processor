import 'reflect-metadata';
import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { Container } from '../../bootstrap/container';
import { HealthController, MetricsController, WageringController, WalletsController } from './controllers';
import { AUTHENTICATOR, AuthGuard, CONTAINER, correlationMiddleware, HttpErrorFilter } from './nest-infrastructure';

@Module({})
export class HttpModule {
  static forRoot(container: Container): DynamicModule {
    return {
      module: HttpModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: CONTAINER, useValue: container },
        { provide: AUTHENTICATOR, useValue: container.authenticator },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}

/** Builds (but does not start) the HTTP application. Used by main.ts and the e2e tests. */
export async function createHttpApp(container: Container): Promise<INestApplication> {
  const app = await NestFactory.create(HttpModule.forRoot(container), {
    logger: container.config.logLevel === 'silent' ? false : ['error', 'warn'],
    bodyParser: true,
  });
  const express = app.getHttpAdapter().getInstance() as { disable(setting: string): void };
  express.disable('x-powered-by');
  app.use(correlationMiddleware(container.logger, container.metrics));
  app.useGlobalFilters(new HttpErrorFilter(container.logger));
  return app;
}
