import schedule from 'node-schedule';
import db from '../db.js';
import { SyncService } from './syncService.js';

const syncService = new SyncService();
const jobs: Record<string, schedule.Job> = {};

export class SchedulerService {
  init() {
    // Load all enabled sync jobs from DB
    const docs = db.prepare('SELECT id, sync_schedule FROM documents WHERE sync_enabled = 1 AND sync_schedule IS NOT NULL').all() as any[];
    
    docs.forEach(doc => {
      this.scheduleJob(doc.id, doc.sync_schedule);
    });
    
    console.log(`Scheduler initialized with ${docs.length} jobs.`);
  }

  scheduleJob(docId: string, cronExpression: string) {
    // Cancel existing job if any
    if (jobs[docId]) {
      jobs[docId].cancel();
    }

    // Schedule new job
    jobs[docId] = schedule.scheduleJob(cronExpression, async () => {
      console.log(`Running scheduled sync for document ${docId}`);
      try {
        // Prevent overlapping: check if already syncing?
        // The syncService updates status in DB. We can check that.
        const doc = db.prepare('SELECT sync_status FROM documents WHERE id = ?').get(docId) as any;
        if (doc && doc.sync_status === 'syncing') {
            console.log(`Skipping sync for ${docId} as it is already syncing.`);
            return;
        }

        await syncService.syncDocument(docId);
      } catch (err) {
        console.error(`Scheduled sync failed for ${docId}:`, err);
      }
    });
  }

  cancelJob(docId: string) {
    if (jobs[docId]) {
      jobs[docId].cancel();
      delete jobs[docId];
    }
  }
}

export const schedulerService = new SchedulerService();
