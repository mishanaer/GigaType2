import { Button } from "./button";
import { Check, LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

interface PermissionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  granted: boolean;
  onRequest: () => void;
  buttonText?: string;
  badge?: string;
  hint?: string;
}

export default function PermissionCard({
  icon: Icon,
  title,
  description,
  granted,
  onRequest,
  buttonText = "Grant Access",
  badge,
  hint,
}: PermissionCardProps) {
  return (
    <div
      className={cn(
        "group relative rounded-md border bg-transparent p-3 transition-colors duration-150",
        granted ? "border-success/20 text-success" : "border-border text-foreground"
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors duration-150",
            granted ? "text-success" : "text-muted-foreground"
          )}
        >
          {granted ? (
            <Check className="w-4 h-4 text-success" strokeWidth={2.5} />
          ) : (
            <Icon className="w-4 h-4 text-primary" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-foreground">
            {title}
            {badge && (
              <span className="ml-1.5 inline-flex items-center text-[10px] font-medium text-muted-foreground">
                {badge}
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">{description}</p>
        </div>

        {!granted && (
          <Button onClick={onRequest} size="sm" className="h-7 px-3 text-xs shrink-0">
            {buttonText}
          </Button>
        )}
      </div>

      {hint && !granted && (
        <p className="text-[11px] text-warning/80 leading-snug mt-2 pl-11">{hint}</p>
      )}
    </div>
  );
}
