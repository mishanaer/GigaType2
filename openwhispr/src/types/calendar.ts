export interface MeetingDetectionPreferences {
  processDetection: boolean;
  audioDetection: boolean;
}

export interface MeetingDetection {
  detectionId: string;
  source: "process" | "audio";
  data: {
    appName?: string;
    durationMs?: number;
    detectedAt: number;
  };
}

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  responseStatus: "needsAction" | "declined" | "tentative" | "accepted" | null;
  self: boolean;
}

export interface Contact {
  email: string;
  display_name: string | null;
}
