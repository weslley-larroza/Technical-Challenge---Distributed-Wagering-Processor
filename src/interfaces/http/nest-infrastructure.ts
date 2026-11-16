import { randomUUID } from 'node:crypto';
import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { INVALID_SPAN_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import type { Logger, Metrics } from '../../application/ports/system';
import { context, propagation, SpanKind, trace, tracer } from '../../infrastructure/observability/tracing';
import type { RequestAuthenticator } from './auth/authenticator';
import { mapError } from './error-mapping';
import type { HttpRequest, HttpResponse } from './http-types';

export const CONTAINER = Symbol('CONTAINER');
export const AUTHENTICATOR = Symbol('AUTHENTICATOR');

const IS_PUBLIC = 'wagering:isPublic';
/** Marks a route as not requiring authentication (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: RequestAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<HttpRequest>();
    request.principal = await this.authenticator.authenticate(request); // throws AuthenticationError → 401
    return true;
  }
}

/** Single place where every error becomes an HTTP response (see error-mapping.ts for the contract). */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const mapped = mapError(exception);

    if (mapped.unexpected) {
      this.logger.error('unhandled error', {
        correlationId: request.correlationId,
        method: request.method,
        path: request.url,
        error: exception instanceof Error ? exception : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    } else if (mapped.status === 503) {
      this.logger.warn('dependency unavailable', { correlationId: request.correlationId, path: request.url, code: mapped.code });
    }

    if (response.headersSent) return;
    for (const [name, value] of Object.entries(mapped.headers ?? {})) response.setHeader(name, value);
    response.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
      correlationId: request.correlationId,
    });
  }
}

const CORRELATION_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Accepts a caller-provided X-Correlation-Id (validated) or generates one, echoes it on
 * the response and writes one structured access-log line per request.
 */
export function correlationMiddleware(logger: Logger, metrics: Metrics) {
  return (
    req: HttpRequest & { path?: string; route?: { path?: string } },
    res: HttpResponse & { statusCode: number; on(event: 'finish', cb: () => void): void },
    next: () => void,
  ) => {
    const incoming = req.headers['x-correlation-id'];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    req.correlationId = candidate && CORRELATION_ID_PATTERN.test(candidate) ? candidate : randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);

    const startedAt = performance.now();
    // SERVER span; continues the caller's trace when it sends a W3C `traceparent`.
    // Probes (/health, /metrics: every few seconds from Docker and Prometheus) are not traced.
    const probe = /^\/(health|metrics)(\/|$|\?)/.test(req.url);
    const parent = propagation.extract(context.active(), req.headers);
    const span = probe
      ? trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
      : tracer().startSpan(
          `HTTP ${req.method}`,
          { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method, 'correlation.id': req.correlationId } },
          parent,
        );
    if (span.isRecording()) res.setHeader('X-Trace-Id', span.spanContext().traceId);

    res.on('finish', () => {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      // route TEMPLATE (e.g. /wallets/:walletId), never the raw path → bounded cardinality
      const labels = { method: req.method, route: req.route?.path ?? 'unmatched', status: String(res.statusCode) };
      span.updateName(`${req.method} ${labels.route}`);
      span.setAttributes({ 'http.route': labels.route, 'http.response.status_code': res.statusCode });
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      metrics.increment('http_requests_total', labels);
      metrics.observe('http_request_duration_ms', durationMs, labels);
      logger.info('http request', {
        correlationId: req.correlationId,
        method: req.method,
        path: req.path ?? req.url,
        status: res.statusCode,
        durationMs,
      });
    });
    if (probe) next();
    else context.with(trace.setSpan(parent, span), next);
  };
}
