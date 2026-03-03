import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

type SessionRecord = {
  token: string;
  expiresAt: number;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const sessions = new Map<string, SessionRecord>();

function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = part.slice(0, idx).trim();
      const value = decodeURIComponent(part.slice(idx + 1));
      acc[key] = value;
      return acc;
    }, {});
}

export function getSessionTokenFromCookie(cookieHeader?: string): string | null {
  const cookies = parseCookies(cookieHeader);
  return cookies.remarcal_session || null;
}

function getAdminPassword(): string {
  const pw = process.env.APP_ADMIN_PASSWORD;
  if (!pw || pw.trim() === '') {
    throw new Error('APP_ADMIN_PASSWORD is required for API authentication.');
  }
  return pw;
}

export function verifyAdminPassword(input: string): boolean {
  const expected = Buffer.from(getAdminPassword(), 'utf8');
  const provided = Buffer.from(input || '', 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export function createSession(): SessionRecord {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  return session;
}

export function clearSession(token?: string): void {
  if (!token) return;
  sessions.delete(token);
}

export function getValidSessionFromCookie(cookieHeader?: string): SessionRecord | null {
  const token = getSessionTokenFromCookie(cookieHeader);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

export function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.APP_SECURE_COOKIES === 'true';
  const parts = [
    `remarcal_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.APP_SECURE_COOKIES === 'true';
  const parts = [
    'remarcal_session=',
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = getValidSessionFromCookie(req.headers.cookie);
  if (!session) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}
