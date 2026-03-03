import { subscriptionService } from './subscriptionService.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000;

export class SubscriptionPollerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (this.timer) return;
    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, POLL_INTERVAL_MS);
    console.log('Subscription poller started (poll every 15 minutes)');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runCycle() {
    if (this.running) return;
    this.running = true;
    try {
      await subscriptionService.fetchDueSubscriptions();
    } finally {
      this.running = false;
    }
  }
}

export const subscriptionPollerService = new SubscriptionPollerService();
