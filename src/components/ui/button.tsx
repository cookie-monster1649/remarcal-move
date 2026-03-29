import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--rm-focus-ring)]',
  {
    variants: {
      variant: {
        default: 'border border-transparent bg-[var(--rm-accent)] text-[var(--rm-accent-foreground)] hover:bg-[var(--rm-accent-hover)] shadow-sm',
        secondary: 'border border-[var(--rm-border-strong)] bg-[var(--rm-surface-elev)] text-[var(--rm-ink)] hover:bg-[var(--rm-surface-soft)]',
        outline: 'border border-[var(--rm-border-strong)] bg-transparent text-[var(--rm-ink)] hover:bg-[var(--rm-surface-soft)]',
        ghost: 'text-[var(--rm-muted)] hover:bg-[var(--rm-surface-soft)] hover:text-[var(--rm-ink)]',
        destructive: 'border border-transparent bg-[var(--rm-danger)] text-white hover:bg-[var(--rm-danger-hover)]',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 rounded-xl px-6',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
