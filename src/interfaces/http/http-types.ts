import type { Principal } from './auth/authenticator';

/** Minimal structural views of express req/res — avoids coupling controllers to express types. */
export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  correlationId: string;
  principal?: Principal;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  headersSent?: boolean;
}
