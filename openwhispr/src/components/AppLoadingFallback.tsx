import Spinner from "../vendor/wallet_animations/components/Spinner";
import { useAppshotsAppleSkin } from "../hooks/useAppshotsAppleSkin";

interface AppLoadingFallbackProps {
  className?: string;
  embedded?: boolean;
}

export default function AppLoadingFallback({
  className = "min-h-screen",
  embedded = false,
}: AppLoadingFallbackProps) {
  useAppshotsAppleSkin();
  const surfaceClassName = embedded ? "appshots-loading-surface" : "appshots-loading-window";

  return (
    <div
      className={`${surfaceClassName} ${className} flex w-full items-center justify-center overflow-hidden`}
    >
      {!embedded && <div className="appshots-window-drag-layer" aria-hidden="true" />}
      <div className="appshots-window-content flex h-full w-full items-center justify-center">
        <Spinner size={28} aria-label="Загрузка" />
      </div>
    </div>
  );
}
