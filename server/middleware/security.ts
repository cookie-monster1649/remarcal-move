import type { NextFunction, Request, Response } from 'express';

type RateLimitOptions = {
  windowMs: number;
  max: number;
};

type RateState = {
  count: number;
  resetAt: number;
};

export function createRateLimiter(options: RateLimitOptions) {
  const store = new Map<string, RateState>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const existing = store.get(key);

    if (!existing || existing.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (existing.count >= options.max) {
      res.status(429).json({ error: 'Too many requests. Please retry later.' });
      return;
    }

    existing.count += 1;
    store.set(key, existing);
    next();
  };
}

export function requestTimeout(ms: number) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setTimeout(ms, () => {
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timed out' });
      }
    });
    next();
  };
}
