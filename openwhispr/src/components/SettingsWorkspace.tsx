import SettingsPage from "./SettingsPage";
import AppshotsLogoHeader from "./ui/AppshotsLogoHeader";

export default function SettingsWorkspace() {
  return (
    <main className="w-full overflow-hidden bg-transparent">
      <div className="mx-auto w-[460px] py-[20px]">
        <AppshotsLogoHeader />
        <SettingsPage />
      </div>
    </main>
  );
}
