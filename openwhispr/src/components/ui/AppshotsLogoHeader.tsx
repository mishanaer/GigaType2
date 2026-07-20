import type { ImgHTMLAttributes } from "react";

import typeLogo from "../../assets/typelogo-176.webp";

const buildVersion = __APP_VERSION__.replace(/\.0$/, "");

type AppshotsLogoHeaderProps = Pick<ImgHTMLAttributes<HTMLImageElement>, "alt"> & {
  showBuildLabel?: boolean;
};

type AppshotsBuildLabelProps = {
  className?: string;
  size?: "default" | "small";
};

export function AppshotsBuildLabel({
  className = "mt-[24px]",
  size = "default",
}: AppshotsBuildLabelProps) {
  return (
    <div
      className={`${className} text-center font-mono ${size === "small" ? "text-[11px]" : "text-[13px]"} leading-none text-muted-foreground`}
    >
      BETA BUILD {buildVersion}
    </div>
  );
}

export default function AppshotsLogoHeader({
  alt = "Type",
  showBuildLabel = true,
}: AppshotsLogoHeaderProps) {
  return (
    <div
      className={`flex flex-col items-center px-[40px] pt-[40px] ${showBuildLabel ? "pb-[40px]" : "pb-0"}`}
      aria-hidden={!alt}
    >
      <img src={typeLogo} alt={alt} className="h-[88px] w-[88px] select-none" draggable={false} />
      {showBuildLabel && <AppshotsBuildLabel />}
    </div>
  );
}
