import express from 'express';
import { createServer as createViteServer } from 'vite';
import cors from 'cors';
import { initDb } from './server/db.js';
import { initEncryption } from './server/services/encryptionService.js';
import { schedulerService } from './server/services/schedulerService.js';
import libraryRoutes from './server/routes/library.js';
import settingsRoutes from './server/routes/settings.js';
import devicesRoutes from './server/routes/devices.js';
import { basicAuth } from './server/middleware/auth.js';

async function startServer() {
  // Initialize services
  try {
    initEncryption();
    initDb();
    schedulerService.init();
  } catch (err: any) {
    console.error('Failed to initialize application:', err.message);
    process.exit(1);
  }

  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API Routes (Authenticated)
  app.use('/api', basicAuth);
  
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

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
