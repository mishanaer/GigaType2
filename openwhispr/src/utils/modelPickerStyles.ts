export type ColorScheme = "purple" | "blue";

export interface ModelPickerStyles {
  container: string;
  header: string;
  modelCard: { selected: string; default: string };
  badges: { selected: string; downloaded: string; recommended: string };
  buttons: { download: string; select: string; delete: string; refresh: string };
}

export const MODEL_PICKER_COLORS: Record<ColorScheme, ModelPickerStyles> = {
  purple: {
    container:
      "bg-muted/95 dark:bg-white/[0.03] rounded-lg overflow-hidden border border-border/60 dark:border-white/8 backdrop-blur-xl shadow-sm",
    header: "font-medium text-foreground tracking-tight",
    modelCard: {
      selected:
        "border-primary/40 bg-primary/12 dark:bg-primary/8 shadow-sm relative before:absolute before:inset-0 before:bg-linear-to-b before:from-white/[0.03] before:to-transparent before:pointer-events-none",
      default:
        "border-border/70 bg-muted/50 dark:bg-white/[0.02] hover:border-ring/60 hover:bg-popover/60 dark:hover:border-white/20 dark:hover:bg-white/[0.05] hover:-translate-y-[1px] hover:shadow-sm transition-[background-color,border-color,transform,box-shadow] duration-200 ease-out",
    },
    badges: {
      selected:
        "text-[10px] text-primary-foreground bg-primary px-1.5 py-0.5 rounded-sm font-medium",
      downloaded:
        "text-[10px] text-success dark:text-success bg-success/10 dark:bg-success/12 px-1.5 py-0.5 rounded-sm",
      recommended:
        "text-[10px] text-primary bg-primary/10 dark:bg-primary/12 px-1.5 py-0.5 rounded-sm font-medium",
    },
    buttons: {
      download: "",
      select: "border-primary/25 text-primary hover:bg-primary/8",
      delete:
        "text-destructive hover:text-destructive/90 hover:bg-destructive/8 border-destructive/25",
      refresh: "border-primary/25 text-primary hover:bg-primary/8",
    },
  },
  blue: {
    container:
      "bg-muted/95 dark:bg-white/[0.03] rounded-lg overflow-hidden border border-border/60 dark:border-white/8 backdrop-blur-xl shadow-sm",
    header: "text-sm font-medium text-foreground tracking-tight",
    modelCard: {
      selected:
        "border-primary/40 bg-primary/12 dark:bg-primary/8 shadow-sm relative before:absolute before:inset-0 before:bg-linear-to-b before:from-white/[0.03] before:to-transparent before:pointer-events-none",
      default:
        "border-border/70 bg-muted/50 dark:bg-white/[0.02] hover:border-ring/60 hover:bg-popover/60 dark:hover:border-white/20 dark:hover:bg-white/[0.05] hover:-translate-y-[1px] hover:shadow-sm transition-[background-color,border-color,transform,box-shadow] duration-200 ease-out",
    },
    badges: {
      selected:
        "text-[10px] text-primary-foreground bg-primary px-1.5 py-0.5 rounded-sm font-medium",
      downloaded: "text-[10px] text-success bg-success/10 px-1.5 py-0.5 rounded-sm font-medium",
      recommended: "text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-sm font-medium",
    },
    buttons: {
      download: "",
      select:
        "border-border text-foreground hover:bg-popover dark:border-white/10 dark:hover:bg-white/8",
      delete:
        "text-destructive hover:text-destructive/90 hover:bg-destructive/8 border-destructive/25",
      refresh:
        "border-border text-foreground hover:bg-popover dark:border-white/10 dark:hover:bg-white/8",
    },
  },
};

export function getModelPickerStyles(colorScheme: ColorScheme): ModelPickerStyles {
  return MODEL_PICKER_COLORS[colorScheme];
}
