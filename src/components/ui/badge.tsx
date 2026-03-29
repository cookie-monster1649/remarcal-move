import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-[var(--rm-border)] bg-[var(--rm-surface-soft)] text-[var(--rm-muted)]',
        success: 'border-[var(--rm-success-border)] bg-[var(--rm-success-bg)] text-[var(--rm-success-fg)]',
        warning: 'border-[var(--rm-warning-border)] bg-[var(--rm-warning-bg)] text-[var(--rm-warning-fg)]',
        destructive: 'border-[var(--rm-danger-border)] bg-[var(--rm-danger-bg)] text-[var(--rm-danger-fg)]',
        info: 'border-[var(--rm-info-border)] bg-[var(--rm-info-bg)] text-[var(--rm-info-fg)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type BadgeProps = React.ComponentProps<'div'> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
