/** Application error with an HTTP status + stable machine code + optional details. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (msg: string, details?: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', msg, details),
  unauthorized: (msg = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', msg),
  forbidden: (msg = 'Permission denied') =>
    new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Resource not found') =>
    new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg: string, details?: unknown) =>
    new AppError(409, 'CONFLICT', msg, details),
  badGateway: (msg: string, details?: unknown) =>
    new AppError(502, 'BAD_GATEWAY', msg, details),
};
