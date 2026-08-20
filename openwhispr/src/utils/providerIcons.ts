import llamaIcon from "@/assets/icons/providers/llama.svg";
import mistralIcon from "@/assets/icons/providers/mistral.svg";
import qwenIcon from "@/assets/icons/providers/qwen.svg";
import nvidiaIcon from "@/assets/icons/providers/nvidia.svg";
import openaiOssIcon from "@/assets/icons/providers/openai-oss.svg";
import gemmaIcon from "@/assets/icons/providers/gemma.svg";

// Local engines only — no hosted provider is reachable from the app.
export const PROVIDER_ICONS: Record<string, string> = {
  llama: llamaIcon,
  mistral: mistralIcon,
  qwen: qwenIcon,
  nvidia: nvidiaIcon,
  "openai-oss": openaiOssIcon,
  gemma: gemmaIcon,
};

export function getProviderIcon(provider: string): string | undefined {
  return PROVIDER_ICONS[provider];
}

export const MONOCHROME_PROVIDERS = ["openai-oss"] as const;

export function isMonochromeProvider(provider: string): boolean {
  return (MONOCHROME_PROVIDERS as readonly string[]).includes(provider);
}
