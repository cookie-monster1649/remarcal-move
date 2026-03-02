import express from 'express';
import { CalDavService } from '../services/caldavService.js';

const router = express.Router();
const calDavService = new CalDavService();

router.post('/fetch', async (req, res) => {
  try {
    const { url, username, password, startDate, endDate } = req.body;
    
    if (!url || !startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const events = await calDavService.fetchEvents({
      url,
      username,
      password,
      startDate,
      endDate
    });

    res.json({ events });
  } catch (error: any) {
    console.error('CalDAV Route Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
