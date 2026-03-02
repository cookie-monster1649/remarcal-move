import { Request, Response, NextFunction } from 'express';

const USER = process.env.AUTH_USER || 'admin';
const PASS = process.env.AUTH_PASS || 'password';

export function basicAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Remarcal"');
    return res.status(401).send('Authentication required');
  }

  const [scheme, credentials] = authHeader.split(' ');

  if (scheme !== 'Basic' || !credentials) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Remarcal"');
    return res.status(401).send('Authentication required');
  }

  const [username, password] = Buffer.from(credentials, 'base64').toString().split(':');

  if (username === USER && password === PASS) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Remarcal"');
  return res.status(401).send('Invalid credentials');
}
