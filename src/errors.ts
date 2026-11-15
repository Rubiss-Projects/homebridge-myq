export class MyQError extends Error {
  constructor(message: string, readonly retryAfterSeconds = 60) {
    super(message);
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MyQError('Unexpected myQ response structure.');
  }
  return value as Record<string, unknown>;
}

export function retryAfter(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 300;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(60, seconds) : 300;
}
