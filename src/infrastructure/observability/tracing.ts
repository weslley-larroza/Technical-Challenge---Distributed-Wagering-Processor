import {
  type Attributes,
  type Context,
  context,
  type Link,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * OpenTelemetry tracing, manual instrumentation at the boundaries (HTTP server span,
 * unit of work, wallet lock wait, SQS consume, outbox publish). Auto-instrumentation is
 * not used: it relies on require hooks that do not work reliably under Bun/ESM, and
 * hand-placed spans carry the domain attributes that matter (walletId, kind, status).
 *
 * Disabled unless OTEL_EXPORTER_OTLP_ENDPOINT is set: the @opentelemetry/api calls then
 * hit the no-op tracer and cost nothing.
 */
export const TRACER_NAME = 'wagering-processor';
export const tracer = () => trace.getTracer(TRACER_NAME);

export interface TracingHandle {
  shutdown(): Promise<void>;
}

export interface TracingOptions {
  serviceName: string;
  instanceId: string;
  /** OTLP/HTTP base URL, e.g. http://localhost:4318 */
  otlpEndpoint?: string;
  /** Tests: export to memory instead of OTLP. */
  exporter?: SpanExporter;
  /** Tests: synchronous processor. */
  processor?: SpanProcessor;
}

export function initTracing(opts: TracingOptions): TracingHandle | undefined {
  if (!opts.otlpEndpoint && !opts.exporter && !opts.processor) return undefined;
  const processor =
    opts.processor ??
    new BatchSpanProcessor(opts.exporter ?? new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` }));
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName, 'service.instance.id': opts.instanceId }),
    spanProcessors: [processor],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return {
    async shutdown() {
      await provider.forceFlush().catch(() => undefined);
      await provider.shutdown().catch(() => undefined);
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}

/** Runs `fn` inside a new active span; records exceptions and always ends the span. */
export async function withSpan<T>(
  name: string,
  options: { kind?: SpanKind; attributes?: Attributes; links?: Link[]; parent?: Context },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = options.parent ?? context.active();
  return tracer().startActiveSpan(name, { kind: options.kind, attributes: options.attributes, links: options.links }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Like withSpan, but only when there is already a recording span to attach to. Used for
 * infrastructure spans (SQL transaction, lock wait): inside a traced operation they are
 * children; on their own — an idle background poll — they would be root traces of pure
 * noise (the first Jaeger run showed ~200 empty `db.transaction` traces per minute).
 */
export function withChildSpan<T>(name: string, options: { attributes?: Attributes }, fn: () => Promise<T>): Promise<T> {
  if (!trace.getActiveSpan()?.isRecording()) return fn();
  return withSpan(name, options, () => fn());
}

/** W3C `traceparent` of the active span (undefined when tracing is off / no span). */
export function currentTraceParent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

export function contextFromTraceParent(traceparent: string | undefined, base: Context = context.active()): Context {
  if (!traceparent) return base;
  return propagation.extract(base, { traceparent });
}

/** Span link to a remote span given its traceparent (async hop: outbox → publish). */
export function linkFromTraceParent(traceparent: string | undefined): Link[] {
  if (!traceparent) return [];
  const spanContext = trace.getSpanContext(propagation.extract(context.active(), { traceparent }));
  return spanContext ? [{ context: spanContext }] : [];
}

export { SpanKind, context, trace, propagation };
