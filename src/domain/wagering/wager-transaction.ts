import { Money } from '../money/money';
import { addMs, type BackoffPolicy, exponentialDelayMs } from '../shared/backoff';
import { DomainValidationError, InvalidTransactionStateError } from '../shared/errors';
import { FailureCode } from '../shared/failure-code';
import { canonicalUuid } from '../shared/identifiers';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // internal only
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Valid transitions:
 *   PENDING           → PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE → PENDING_REFERENCE (re-scheduled) | PROCESSED | REJECTED | FAILED
 *   PROCESSED / REJECTED / FAILED → (none — terminal)
 */
const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Kinds a provider may submit (OPENING is internal). */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Which kinds each kind may reference. */
export const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/** Out-of-order reference retry policy: ~18 min total before REFERENCE_NOT_FOUND. */
export const REFERENCE_RETRY_POLICY: Readonly<BackoffPolicy & { maxAttempts: number }> = Object.freeze({
  baseMs: 2_000,
  maxMs: 5 * 60_000,
  maxAttempts: 10,
});

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Wallet balance observed when the transaction reached its outcome (for faithful replays). */
  balanceAfter?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
  updatedAt: Date;
}

const MAX_ID_LENGTH = 128;

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Born PENDING. Validates input shape and reference requirements per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new DomainValidationError(`kind "${props.kind}" cannot be submitted`);
    }
    WagerTransaction.validateCommon(props);
    const walletId = canonicalUuid('walletId', props.walletId);
    const playerId = canonicalUuid('playerId', props.playerId);
    const ref = props.referenceExternalTransactionId;
    const requires = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requires && !ref) {
      throw new DomainValidationError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (ref !== undefined) {
      if (ALLOWED_REFERENCE_KINDS[props.kind].length === 0) {
        throw new DomainValidationError(`${props.kind} cannot reference another transaction`);
      }
      assertId('referenceExternalTransactionId', ref);
      if (ref === props.externalTransactionId) {
        throw new DomainValidationError('a transaction cannot reference itself');
      }
    }
    return WagerTransaction.build({
      ...props,
      walletId,
      playerId,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /** Internal OPENING credit, born PROCESSED together with the wallet. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new DomainValidationError('opening amount must be positive');
    }
    const externalId = `opening:${props.walletId}`;
    return WagerTransaction.build({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      processedAt: props.at,
      balanceAfter: props.money,
      referenceAttempts: 0,
      updatedAt: props.at,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return WagerTransaction.build(state);
  }

  // ---- getters
  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions
  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  /** Records one more failed attempt to resolve the reference and schedules the next one. */
  markPendingReference(now: Date): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = addMs(now, exponentialDelayMs(REFERENCE_RETRY_POLICY, this._referenceAttempts));
    this._updatedAt = now;
  }

  hasExhaustedReferenceRetries(): boolean {
    return this._referenceAttempts >= REFERENCE_RETRY_POLICY.maxAttempts;
  }

  reject(code: FailureCode, balanceObserved: Money | undefined, at: Date): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceObserved;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries
  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverts the referenced movement; others have a fixed direction. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK direction requires the referenced transaction');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS has no ledger direction');
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${action}: transaction ${this.id} is ${this._status}`);
    }
  }

  private static validateCommon(p: CreateWagerTransactionProps): void {
    assertId('providerId', p.providerId);
    assertId('externalTransactionId', p.externalTransactionId);
    assertId('idempotencyKey', p.idempotencyKey, 256);
    assertId('roundId', p.roundId);
    assertId('gameId', p.gameId);
    if (p.providerId === INTERNAL_PROVIDER_ID) {
      throw new DomainValidationError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    if (!p.money.isPositive()) {
      throw new DomainValidationError('money must be greater than zero');
    }
  }

  private static build(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.balanceAfter,
      s.referenceAttempts,
      s.nextReferenceCheckAt,
      s.updatedAt,
    );
  }
}

function assertId(field: string, value: unknown, max = MAX_ID_LENGTH): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainValidationError(`${field} is required`);
  }
  if (value.length > max) {
    throw new DomainValidationError(`${field} exceeds ${max} characters`);
  }
}
