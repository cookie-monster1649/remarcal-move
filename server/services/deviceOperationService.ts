type DeviceOperation = 'sync' | 'backup';

interface LockState {
  operation: DeviceOperation;
  startedAt: string;
}

export class DeviceOperationService {
  private locks = new Map<string, LockState>();

  tryAcquire(deviceId: string, operation: DeviceOperation): { ok: true } | { ok: false; reason: string } {
    const existing = this.locks.get(deviceId);
    if (!existing) {
      this.locks.set(deviceId, { operation, startedAt: new Date().toISOString() });
      return { ok: true };
    }

    if (existing.operation === operation) {
      return { ok: false, reason: `${operation} already in progress` };
    }

    return { ok: false, reason: `${existing.operation} is in progress` };
  }

  release(deviceId: string, operation: DeviceOperation): void {
    const existing = this.locks.get(deviceId);
    if (!existing) return;
    if (existing.operation !== operation) return;
    this.locks.delete(deviceId);
  }

  getCurrent(deviceId: string): LockState | null {
    return this.locks.get(deviceId) || null;
  }
}

export const deviceOperationService = new DeviceOperationService();
