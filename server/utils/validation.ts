export class ValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`);
  }
  return value;
}

export function optionalInteger(
  value: unknown,
  field: string,
  min?: number,
  max?: number,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  if (min !== undefined && n < min) {
    throw new ValidationError(`${field} must be >= ${min}`);
  }
  if (max !== undefined && n > max) {
    throw new ValidationError(`${field} must be <= ${max}`);
  }
  return n;
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array`);
  }

  const parsed = value.map((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new ValidationError(`${field}[${i}] must be a non-empty string`);
    }
    return v.trim();
  });

  return Array.from(new Set(parsed));
}

export function validateCalendars(value: unknown, field: string): { url: string; name: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array`);
  }

  return value.map((item, i) => {
    if (!isObject(item)) {
      throw new ValidationError(`${field}[${i}] must be an object`);
    }
    return {
      url: requireString(item.url, `${field}[${i}].url`),
      name: requireString(item.name, `${field}[${i}].name`),
    };
  });
}

export function getErrorMessage(err: unknown): { status: number; message: string } {
  if (err instanceof ValidationError) {
    return { status: err.status, message: err.message };
  }
  if (err instanceof Error) {
    return { status: 500, message: err.message };
  }
  return { status: 500, message: 'Unknown error' };
}
