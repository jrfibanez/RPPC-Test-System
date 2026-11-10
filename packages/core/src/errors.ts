/** Errors carry an HTTP status so route handlers can map them without leaking stack traces (§8.5). */
export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'bad_request') { super(message); }
}
export class Forbidden extends AppError { constructor(m = 'forbidden') { super(m, 403, 'forbidden'); } }
export class Unauthorized extends AppError { constructor(m = 'not signed in') { super(m, 401, 'unauthorized'); } }
export class NotFound extends AppError { constructor(m = 'not found') { super(m, 404, 'not_found'); } }
export class Conflict extends AppError { constructor(m: string) { super(m, 409, 'conflict'); } }
/** A business rule (BR-xx) refused the action. */
export class RuleViolation extends AppError {
  constructor(public rule: string, m: string) { super(`${rule}: ${m}`, 422, 'rule_violation'); }
}
