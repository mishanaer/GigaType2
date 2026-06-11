import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();
  const remoteTranscriptionUrl = useSettingsStore((s) => s.remoteTranscriptionUrl);

  return (
    <div className="space-y-3">
      <SettingsRow
        label={t("settingsPage.transcription.model", { defaultValue: "Transcription model" })}
        description={remoteTranscriptionUrl || "GigaAM"}
      >
        <span className="text-sm font-medium text-foreground">GigaAM</span>
      </SettingsRow>
      <MeetingSpeakerDetectionRow />
    </div>
  );
}
