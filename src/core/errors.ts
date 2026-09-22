/**
 * Error taxonomy for the service.
 *
 * Every failure the application raises on purpose is an `AppError`, carrying the
 * HTTP status and a stable machine-readable `code`. The server maps these to
 * RFC 7807 problem documents in one place, so route handlers never build error
 * payloads by hand and no unexpected error can leak its stack to a client.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: ReadonlyArray<FieldIssue>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

/** Input failed validation. The `details` list is safe to show to the user. */
export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = 'validation_failed';
}

/** The slug is already taken. Shortcuts are never silently overwritten. */
export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = 'slug_taken';
}

/** The caller is identified but is not the shortcut's owner. */
export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code = 'not_owner';
}

/** No shortcut exists for the requested slug. */
export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = 'shortcut_not_found';
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
