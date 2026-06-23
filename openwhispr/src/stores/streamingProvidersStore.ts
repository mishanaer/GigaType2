import { create } from "zustand";

export interface NoteRecordingProviderModel {
  id: string;
  name: string;
  default?: boolean;
}

export interface NoteRecordingProvider {
  id: string;
  name: string;
  models: NoteRecordingProviderModel[];
}

interface StreamingProvidersState {
  providers: NoteRecordingProvider[] | null;
}

const STATIC_PROVIDERS: NoteRecordingProvider[] = [
  {
    id: "gigaam",
    name: "GigaAM",
    models: [{ id: "gigaam-v3-e2e-rnnt", name: "GigaAM v3", default: true }],
  },
];

export const useStreamingProvidersStore = create<StreamingProvidersState>()(() => ({
  providers: STATIC_PROVIDERS,
}));

export async function fetchProviders(): Promise<NoteRecordingProvider[] | null> {
  useStreamingProvidersStore.setState({ providers: STATIC_PROVIDERS });
  return STATIC_PROVIDERS;
}
