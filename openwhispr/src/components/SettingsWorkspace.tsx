import SettingsPage from "./SettingsPage";
import AppshotsLogoHeader, { AppshotsBuildLabel } from "./ui/AppshotsLogoHeader";
import DailyDictationHeadline from "./ui/DailyDictationHeadline";

export default function SettingsWorkspace() {
  return (
    <main className="w-full overflow-hidden bg-transparent">
      <div className="mx-auto w-[460px] pb-[20px] pt-[20px]">
        <AppshotsLogoHeader showBuildLabel={false} />
        <DailyDictationHeadline />
        <div className="mt-[24px]">
          <SettingsPage />
        </div>
        <AppshotsBuildLabel className="mt-[16px]" size="small" />
      </div>
    </main>
  );
}
