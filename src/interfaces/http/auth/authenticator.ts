/**
 * Authentication extension point (section 2). The HTTP layer only knows this port:
 *   - AllowAllAuthenticator  : default, no IdP configured (documented decision)
 *   - OidcJwtAuthenticator   : Keycloak / any OIDC IdP (plugged in last)
 *
 * Authorization rule enforced at the edge: a principal bound to provider(s) may only
 * submit / read transactions of those providers. The queue is an internal trusted
 * channel, but its provider id still goes through the same domain validations.
 */
export interface Principal {
  subject: string;
  /** undefined = not restricted to specific providers (e.g. back-office / anonymous mode). */
  providerIds?: readonly string[];
}

export interface AuthenticationRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface RequestAuthenticator {
  /** Resolves the caller or throws AuthenticationError. */
  authenticate(request: AuthenticationRequest): Promise<Principal>;
}

export class AuthenticationError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor(message = 'missing or invalid credentials') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ProviderForbiddenError extends Error {
  readonly code = 'PROVIDER_FORBIDDEN';
  constructor(providerId: string) {
    super(`caller is not allowed to act for provider ${providerId}`);
    this.name = 'ProviderForbiddenError';
  }
}

export class AllowAllAuthenticator implements RequestAuthenticator {
  async authenticate(): Promise<Principal> {
    return { subject: 'anonymous' };
  }
}

export function assertProviderAccess(principal: Principal | undefined, providerId: string): void {
  if (principal?.providerIds && !principal.providerIds.includes(providerId)) {
    throw new ProviderForbiddenError(providerId);
  }
}
