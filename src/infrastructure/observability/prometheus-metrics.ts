import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Labels, Metrics } from '../../application/ports/system';

interface MetricSpec {
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
}

const LATENCY_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
// Dense in the 1–60 s range: the load test showed lag living there under saturation, and
// coarse buckets (15 s → 60 s) made interpolated p95/p99 meaningless.
const LAG_MS = [10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 120_000, 300_000];

/**
 * Catalogue of every metric the application emits (section 12). Declared up front so the
 * label sets are fixed and documented; label values are always low-cardinality enums
 * (never ids or amounts).
 */
const COUNTERS: Record<string, MetricSpec> = {
  wager_transactions_total: { help: 'Wager transactions settled, by final status', labels: ['kind', 'status', 'source'] },
  idempotent_replays_total: { help: 'Duplicate requests answered with the original result', labels: ['source'] },
  idempotency_conflicts_total: { help: 'Same key / external id with a different payload', labels: ['code'] },
  inbox_duplicates_total: { help: 'Queue messages already processed (inbox hit)', labels: ['consumer'] },
  persistence_retries_total: { help: 'Unit-of-work retries (unique race, deadlock, lock timeout, connection)', labels: ['operation', 'reason'] },
  lock_conflicts_total: { help: 'Row-lock conflicts: deadlocks and lock timeouts', labels: ['operation', 'reason'] },
  pending_reference_resolutions_total: { help: 'PENDING_REFERENCE transactions re-evaluated', labels: ['outcome', 'trigger'] },
  reconciliation_mismatches_total: { help: 'Wallets whose balance differs from the ledger', labels: [] },
  sqs_messages_total: { help: 'Queue messages handled', labels: ['consumer', 'outcome', 'status', 'code'] },
  sqs_retries_total: { help: 'Queue messages scheduled for redelivery', labels: ['consumer', 'reason'] },
  sqs_dlq_total: { help: 'Queue messages moved to the DLQ', labels: ['consumer', 'reason'] },
  sqs_receive_errors_total: { help: 'Failed SQS receive calls', labels: ['consumer'] },
  outbox_published_total: { help: 'Outbox events published', labels: ['eventType'] },
  outbox_publish_failures_total: { help: 'Outbox publish attempts that failed', labels: ['eventType'] },
  http_requests_total: { help: 'HTTP requests', labels: ['method', 'route', 'status'] },
};

const HISTOGRAMS: Record<string, MetricSpec> = {
  wager_processing_duration_ms: { help: 'End-to-end submission latency (incl. retries)', labels: ['source'], buckets: LATENCY_MS },
  outbox_lag_ms: { help: 'Commit → broker acceptance delay per event', labels: ['eventType'], buckets: LAG_MS },
  http_request_duration_ms: { help: 'HTTP request latency', labels: ['method', 'route', 'status'], buckets: LATENCY_MS },
};

export interface GaugeSample {
  labels?: Labels;
  value: number;
}

export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();

  constructor(defaultLabels: Labels = {}) {
    this.registry.setDefaultLabels({ ...defaultLabels });
    collectDefaultMetrics({ register: this.registry });
    for (const [name, spec] of Object.entries(COUNTERS)) {
      this.counters.set(name, new Counter({ name, help: spec.help, labelNames: [...spec.labels], registers: [this.registry] }));
    }
    for (const [name, spec] of Object.entries(HISTOGRAMS)) {
      this.histograms.set(
        name,
        new Histogram({ name, help: spec.help, labelNames: [...spec.labels], buckets: [...(spec.buckets ?? LATENCY_MS)], registers: [this.registry] }),
      );
    }
  }

  increment(name: string, labels: Labels = {}, value = 1): void {
    this.counter(name, labels).inc(this.only(name, labels, COUNTERS), value);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const histogram = this.histograms.get(name);
    if (!histogram) return; // unknown histograms are ignored rather than crashing a request
    histogram.observe(this.only(name, labels, HISTOGRAMS), value);
  }

  /**
   * Gauges computed at scrape time (outbox backlog, queue depths). A failing collector
   * keeps the last value instead of failing the whole scrape.
   */
  registerGauge(name: string, help: string, labelNames: readonly string[], collect: () => Promise<GaugeSample[]>): void {
    new Gauge({
      name,
      help,
      labelNames: [...labelNames],
      registers: [this.registry],
      async collect() {
        try {
          const samples = await collect();
          for (const s of samples) this.set({ ...(s.labels ?? {}) }, s.value);
        } catch {
          // dependency down: keep last observed values
        }
      },
    });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  private counter(name: string, labels: Labels): Counter<string> {
    let counter = this.counters.get(name);
    if (!counter) {
      // Not in the catalogue: register on first use with the labels it was called with.
      counter = new Counter({ name, help: name, labelNames: Object.keys(labels), registers: [this.registry] });
      this.counters.set(name, counter);
      COUNTERS[name] = { help: name, labels: Object.keys(labels) };
    }
    return counter;
  }

  /** Drops labels that are not declared for the metric (prom-client would throw). */
  private only(name: string, labels: Labels, catalogue: Record<string, MetricSpec>): Record<string, string> {
    const allowed = catalogue[name]?.labels ?? [];
    const out: Record<string, string> = {};
    for (const key of allowed) if (labels[key] !== undefined) out[key] = labels[key]!;
    return out;
  }
}
