import type { ImgHTMLAttributes } from "react";

import typeLogo from "../../assets/typelogo-176.webp";

type AppshotsLogoHeaderProps = Pick<ImgHTMLAttributes<HTMLImageElement>, "alt"> & {
  showBuildLabel?: boolean;
};

export default function AppshotsLogoHeader({
  alt = "GigaType",
  showBuildLabel = true,
}: AppshotsLogoHeaderProps) {
  return (
    <div
      className={`flex flex-col items-center px-[40px] pt-[40px] ${showBuildLabel ? "pb-[40px]" : "pb-0"}`}
      aria-hidden={!alt}
    >
      <img src={typeLogo} alt={alt} className="h-[88px] w-[88px] select-none" draggable={false} />
      {showBuildLabel && (
        <div className="mt-[24px] font-mono text-[13px] leading-none text-muted-foreground">
          DEV BUILD 0.1
        </div>
      )}
    </div>
  );
}
