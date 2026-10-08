export class DomainError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class TableLockedError extends DomainError {
  constructor(tableNumber: string, lockedBy: string) {
    super(`Table ${tableNumber} is currently locked by ${lockedBy}`, 409);
  }
}

export class InvalidTableStateTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Cannot transition table from '${from}' to '${to}'`, 422);
  }
}

export class TableNotFoundError extends DomainError {
  constructor(identifier: string) {
    super(`Table not found: ${identifier}`, 404);
  }
}

export class OrderNotFoundError extends DomainError {
  constructor(identifier: string) {
    super(`Order not found: ${identifier}`, 404);
  }
}

export class OrderAlreadySettledError extends DomainError {
  constructor(orderId: string) {
    super(`Order ${orderId} is already settled and closed`, 400);
  }
}

export class InvalidManagerPinError extends DomainError {
  constructor() {
    super('Unauthorized: Action requires valid Manager PIN authorization', 403);
  }
}

export class ItemNotFoundError extends DomainError {
  constructor(identifier: string) {
    super(`Item not found: ${identifier}`, 404);
  }
}

export class InsufficientPaymentError extends DomainError {
  constructor(remaining: number) {
    super(`Payment amount exceeds remaining balance or invalid: ${remaining.toFixed(2)} TL remaining`, 400);
  }
}

export class InvalidSplitError extends DomainError {
  constructor(reason: string) {
    super(`Bill split error: ${reason}`, 400);
  }
}

export class PrinterOfflineError extends DomainError {
  constructor(message: string) {
    super(`Printer communication failure: ${message}`, 503);
  }
}
