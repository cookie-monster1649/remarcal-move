import express from 'express';
import {
  clearSession,
  clearSessionCookie,
  createSession,
  getSessionTokenFromCookie,
  getValidSessionFromCookie,
  setSessionCookie,
  verifyAdminPassword,
} from '../services/authService.js';
import { createRateLimiter } from '../middleware/security.js';

const router = express.Router();
const authLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

router.post('/login', authLimiter, (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const session = createSession();
  setSessionCookie(res, session.token);
  res.json({ message: 'Authenticated' });
});

router.post('/logout', (req, res) => {
  const token = getSessionTokenFromCookie(req.headers.cookie);
  clearSession(token || undefined);
  clearSessionCookie(res);
  res.json({ message: 'Logged out' });
});

router.get('/me', (req, res) => {
  const session = getValidSessionFromCookie(req.headers.cookie);
  if (!session) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true });
});

export default router;
