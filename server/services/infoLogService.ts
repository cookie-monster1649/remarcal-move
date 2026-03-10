import * as fs from 'fs';
import * as path from 'path';

interface InfoLogEvent {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

function getLogPath(): string {
  const dataDir = process.env.DATA_DIR || './data';
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'info.log');
}

export class InfoLogService {
  private readonly logPath = getLogPath();

  write(event: string, payload: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') {
    const entry: InfoLogEvent = {
      ts: new Date().toISOString(),
      level,
      event,
      ...payload,
    };
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFile(this.logPath, line, (err) => {
      if (err) {
        console.warn('Failed to append info log:', err.message);
      }
    });
  }

  tail(limit = 200): InfoLogEvent[] {
    try {
      const raw = fs.readFileSync(this.logPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(limit, 2000))).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

export const infoLogService = new InfoLogService();
