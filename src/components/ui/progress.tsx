import * as React from 'react';
import { cn } from '../../lib/utils';

interface ProgressProps {
  value?: number;
  className?: string;
  [key: string]: any;
}

function Progress({ className, value = 0, ...props }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-[var(--rm-progress-track)]', className)} {...props}>
      <div className="h-full bg-[var(--rm-progress-fill)] transition-all duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

export { Progress };
