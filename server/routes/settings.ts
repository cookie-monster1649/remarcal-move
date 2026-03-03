import express from 'express';
import db from '../db.js';
import { encrypt } from '../services/encryptionService.js';
import { CalDavService } from '../services/caldavService.js';
import { decrypt } from '../services/encryptionService.js';
import { subscriptionService } from '../services/subscriptionService.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getErrorMessage,
  isObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireString,
  validateCalendars,
  ValidationError,
} from '../utils/validation.js';

const router = express.Router();
const caldavService = new CalDavService();

function todayRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// List Accounts (redact password)
router.get('/', (req, res) => {
  const accounts = db.prepare('SELECT id, name, url, username, selected_calendars, created_at FROM caldav_accounts').all();
  res.json(accounts);
});

// List ICS subscriptions (URL is secret, never returned)
router.get('/subscriptions', (req, res) => {
  const subscriptions = db.prepare(`
    SELECT id, name, update_frequency_minutes, enabled, last_fetched_at, last_success_at, last_error, created_at
    FROM calendar_subscriptions
    ORDER BY created_at DESC
  `).all();
  res.json(subscriptions);
});

// Discover Calendars
router.post('/discover', async (req, res) => {
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const url = requireString(req.body.url, 'url');
    const username = optionalString(req.body.username, 'username');
    const password = optionalString(req.body.password, 'password');
    const accountId = optionalString(req.body.accountId, 'accountId');

    const calendars = await caldavService.discoverCalendars({ url, username, password, accountId });
    res.json(calendars);
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Create Account
router.post('/', (req, res) => {
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const name = requireString(req.body.name, 'name');
    const url = requireString(req.body.url, 'url');
    const username = requireString(req.body.username, 'username');
    const password = requireString(req.body.password, 'password');
    const selected_calendars = validateCalendars(req.body.selected_calendars, 'selected_calendars');
    const id = uuidv4();

    const encrypted_password = encrypt(password);
    db.prepare(`
      INSERT INTO caldav_accounts (id, name, url, username, encrypted_password, selected_calendars)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, url, username, encrypted_password, JSON.stringify(selected_calendars || []));
    
    res.json({ id, message: 'Account created' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Update Account
router.put('/:id', (req, res) => {
  const { id } = req.params;
  
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const name = requireString(req.body.name, 'name');
    const url = requireString(req.body.url, 'url');
    const username = requireString(req.body.username, 'username');
    const password = optionalString(req.body.password, 'password');
    const selected_calendars = validateCalendars(req.body.selected_calendars, 'selected_calendars');

    if (password) {
      const encrypted_password = encrypt(password);
      db.prepare(`
        UPDATE caldav_accounts 
        SET name = ?, url = ?, username = ?, encrypted_password = ?, selected_calendars = ?
        WHERE id = ?
      `).run(name, url, username, encrypted_password, JSON.stringify(selected_calendars || []), id);
    } else {
      db.prepare(`
        UPDATE caldav_accounts 
        SET name = ?, url = ?, username = ?, selected_calendars = ?
        WHERE id = ?
      `).run(name, url, username, JSON.stringify(selected_calendars || []), id);
    }
    
    res.json({ message: 'Account updated' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Delete Account
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(id);
    res.json({ message: 'Account deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Test existing CalDAV account connectivity/fetch
router.post('/:id/test', async (req, res) => {
  const { id } = req.params;
  try {
    const account = db.prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(id) as any;
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const selectedCalendars = (() => {
      try {
        const parsed = JSON.parse(account.selected_calendars || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

    const targetUrl = selectedCalendars.length > 0 ? selectedCalendars[0].url : account.url;
    const { startDate, endDate } = todayRange();
    const result = await caldavService.fetchEvents({
      url: targetUrl,
      username: account.username,
      password: decrypt(account.encrypted_password),
      startDate,
      endDate,
    });

    res.json({
      status: 'ok',
      message: 'CalDAV connection successful',
      eventsFetched: result.events.length,
    });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status === 500 ? 400 : error.status).json({ error: error.message });
  }
});

// Create Subscription
router.post('/subscriptions', (req, res) => {
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const name = requireString(req.body.name, 'name');
    const url = requireString(req.body.url, 'url');
    const update_frequency_minutes = optionalInteger(req.body.update_frequency_minutes, 'update_frequency_minutes', 15, 1440) || 30;
    const enabled = optionalBoolean(req.body.enabled, 'enabled');
    const id = uuidv4();

    db.prepare(`
      INSERT INTO calendar_subscriptions (id, name, encrypted_url, update_frequency_minutes, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, encrypt(url), update_frequency_minutes, enabled === false ? 0 : 1);

    res.json({ id, message: 'Subscription created' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Update Subscription
router.put('/subscriptions/:id', (req, res) => {
  const { id } = req.params;
  try {
    if (!isObject(req.body)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const existing = db.prepare('SELECT id FROM calendar_subscriptions WHERE id = ?').get(id) as any;
    if (!existing) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const name = requireString(req.body.name, 'name');
    const url = optionalString(req.body.url, 'url');
    const update_frequency_minutes = optionalInteger(req.body.update_frequency_minutes, 'update_frequency_minutes', 15, 1440) || 30;
    const enabled = optionalBoolean(req.body.enabled, 'enabled');

    if (url) {
      db.prepare(`
        UPDATE calendar_subscriptions
        SET name = ?, encrypted_url = ?, update_frequency_minutes = ?, enabled = ?
        WHERE id = ?
      `).run(name, encrypt(url), update_frequency_minutes, enabled === false ? 0 : 1, id);
    } else {
      db.prepare(`
        UPDATE calendar_subscriptions
        SET name = ?, update_frequency_minutes = ?, enabled = ?
        WHERE id = ?
      `).run(name, update_frequency_minutes, enabled === false ? 0 : 1, id);
    }

    res.json({ message: 'Subscription updated' });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status).json({ error: error.message });
  }
});

// Delete Subscription
router.delete('/subscriptions/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM calendar_subscriptions WHERE id = ?').run(id);
    res.json({ message: 'Subscription deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch/sync a single subscription immediately
router.post('/subscriptions/:id/fetch', async (req, res) => {
  const { id } = req.params;
  try {
    const sub = db.prepare('SELECT id FROM calendar_subscriptions WHERE id = ?').get(id) as any;
    if (!sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    await subscriptionService.fetchSubscription(id);
    const eventCount = (db.prepare('SELECT COUNT(*) as count FROM subscription_events WHERE subscription_id = ?').get(id) as any)?.count || 0;

    res.json({
      status: 'ok',
      message: 'Subscription fetched successfully',
      eventsStored: eventCount,
    });
  } catch (err: any) {
    const error = getErrorMessage(err);
    res.status(error.status === 500 ? 400 : error.status).json({ error: error.message });
  }
});

export default router;
