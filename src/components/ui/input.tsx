import * as React from 'react';
import { cn } from '../../lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => {
  return (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-xl border border-[var(--rm-border-strong)] bg-[var(--rm-surface-elev)] px-3 py-2 text-sm text-[var(--rm-ink)] ring-offset-transparent placeholder:text-[var(--rm-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rm-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
