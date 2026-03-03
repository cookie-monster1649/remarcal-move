import express from 'express';
import { createServer as createViteServer } from 'vite';
import cors from 'cors';
import { initDb } from './server/db.js';
import { initEncryption } from './server/services/encryptionService.js';
import { connectionSyncService } from './server/services/connectionSyncService.js';
import { subscriptionPollerService } from './server/services/subscriptionPollerService.js';
import libraryRoutes from './server/routes/library.js';
import settingsRoutes from './server/routes/settings.js';
import devicesRoutes from './server/routes/devices.js';
import authRoutes from './server/routes/auth.js';
import { requireAuth } from './server/services/authService.js';
import { createRateLimiter, requestTimeout } from './server/middleware/security.js';

async function startServer() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    console.error('Refusing to start: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate validation.');
    process.exit(1);
  }

  if (!process.env.APP_ADMIN_PASSWORD || process.env.APP_ADMIN_PASSWORD.trim() === '') {
    console.error('Refusing to start: APP_ADMIN_PASSWORD is required for UI/API authentication.');
    process.exit(1);
  }

  // Initialize services
  try {
    initEncryption();
    initDb();
    connectionSyncService.start();
    subscriptionPollerService.start();
  } catch (err: any) {
    console.error('Failed to initialize application:', err.message);
    process.exit(1);
  }

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const allowedOrigin = process.env.APP_ALLOWED_ORIGIN || `http://localhost:${PORT}`;

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin === allowedOrigin || origin === `http://localhost:${PORT}`) {
        return callback(null, true);
      }
      return callback(new Error('CORS blocked for origin'));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '256kb' }));
  app.use(requestTimeout(60_000));
  app.use(createRateLimiter({ windowMs: 60_000, max: 300 }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // API Routes
  
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', requireAuth);

  app.use('/api/library', libraryRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/devices', devicesRoutes);

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve static files
    app.use(express.static('dist'));
    // Fallback to index.html for SPA routing
    app.get('*', (req, res) => {
        res.sendFile('index.html', { root: 'dist' });
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
