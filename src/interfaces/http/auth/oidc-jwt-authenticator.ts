import { createRemoteJWKSet, errors as joseErrors, type JWTPayload, jwtVerify } from 'jose';
import { TransientInfrastructureError } from '../../../application/errors';
import {
  type AuthenticationRequest,
  AuthenticationError,
  type Principal,
  type RequestAuthenticator,
} from './authenticator';

export interface OidcSettings {
  /** Expected `iss` (e.g. http://localhost:8080/realms/wagering). */
  issuer: string;
  /**
   * Where to fetch signing keys. Separate from the issuer on purpose: inside Docker the
   * app reaches Keycloak as http://keycloak:8080 while tokens say http://localhost:8080.
   */
  jwksUri: string;
  /** Expected `aud`. */
  audience: string;
  /** Claim holding the provider id(s) the caller may act for. */
  providerClaim: string;
  /** Realm role that grants unrestricted (back-office) access. */
  backofficeRole: string;
}

/**
 * Validates OAuth2 bearer access tokens issued by an external OIDC IdP (Keycloak):
 * signature against the realm JWKS (cached, rotated automatically), `iss`, `aud`, `exp`,
 * `nbf`, asymmetric algorithms only. No user table, no passwords in this service.
 *
 * Principal mapping:
 *   - `provider_id` claim (string or string[]) → providerIds   (provider clients)
 *   - realm role `wagering-backoffice`          → unrestricted  (operations)
 *   - neither                                    → providerIds = [] (authenticated, may act for nobody)
 */
export class OidcJwtAuthenticator implements RequestAuthenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly settings: OidcSettings) {
    this.jwks = createRemoteJWKSet(new URL(settings.jwksUri), {
      timeoutDuration: 2_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  async authenticate(request: AuthenticationRequest): Promise<Principal> {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = value ? /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(value) : null;
    if (!match?.[1]) throw new AuthenticationError('missing bearer token');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'],
        clockTolerance: 5,
      }));
    } catch (error) {
      // A jose validation error (signature, exp, iss, aud, malformed) → bad credentials (401).
      // Anything else — key server unreachable / timeout — is infrastructure (503, retryable).
      if (error instanceof joseErrors.JOSEError && !(error instanceof joseErrors.JWKSTimeout)) {
        throw new AuthenticationError('invalid token');
      }
      throw new TransientInfrastructureError('identity provider unreachable', { cause: error });
    }

    const roles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    if (Array.isArray(roles) && roles.includes(this.settings.backofficeRole)) {
      return { subject: String(payload.sub ?? payload.azp ?? 'unknown') };
    }
    const claim = payload[this.settings.providerClaim];
    const providerIds = typeof claim === 'string' ? [claim] : Array.isArray(claim) ? claim.filter((c): c is string => typeof c === 'string') : [];
    return { subject: String(payload.sub ?? payload.azp ?? 'unknown'), providerIds };
  }
}
