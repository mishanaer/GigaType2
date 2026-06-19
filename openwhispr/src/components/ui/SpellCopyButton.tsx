"use client";

import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { cn } from "@/components/lib/utils";

type SizeVariant = "sm" | "default" | "lg";

interface CopyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value?: string;
  onCopy?: () => Promise<void> | void;
  size?: SizeVariant;
}

const sizeMap: Record<SizeVariant, { button: string; icon: number }> = {
  sm: { button: "h-8 w-8", icon: 14 },
  default: { button: "h-9 w-9", icon: 20 },
  lg: { button: "h-12 w-12", icon: 20 },
};

const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ value, onCopy, size = "default", className, onClick, ...props }, ref) => {
    const [copied, setCopied] = React.useState<boolean>(false);
    const resetTimerRef = React.useRef<number | null>(null);

    React.useEffect(() => {
      return () => {
        if (resetTimerRef.current !== null) {
          window.clearTimeout(resetTimerRef.current);
        }
      };
    }, []);

    const showCopiedState = React.useCallback(() => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }

      setCopied(true);

      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 1500);
    }, []);

    const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);

      if (event.defaultPrevented || copied) {
        return;
      }

      if (!onCopy && !value) {
        return;
      }

      showCopiedState();

      try {
        if (onCopy) {
          await onCopy();
        } else if (value) {
          await navigator.clipboard.writeText(value);
        }
      } catch (error) {
        console.warn("Failed to copy", error);
      }
    };

    const { button: buttonSize, icon: iconSize } = sizeMap[size];

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        disabled={copied}
        className={cn(
          "relative cursor-pointer active:scale-[0.96] transition-transform ease-out duration-150 inline-flex items-center justify-center rounded-md text-neutral-900 disabled:pointer-events-none disabled:opacity-100 dark:text-neutral-50",
          buttonSize,
          className
        )}
        {...props}
      >
        <span
          className="relative inline-flex items-center justify-center"
          style={{ width: iconSize, height: iconSize }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <m.span
              key={copied ? "copied" : "copy"}
              className="absolute inset-0 inline-flex items-center justify-center"
              initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            >
              {copied ? (
                <CheckIcon size={iconSize} strokeWidth={2} aria-hidden="true" />
              ) : (
                <CopyIcon size={iconSize} strokeWidth={2} aria-hidden="true" />
              )}
            </m.span>
          </AnimatePresence>
        </span>
      </button>
    );
  }
);

CopyButton.displayName = "CopyButton";

export { CopyButton };
export type { CopyButtonProps };
