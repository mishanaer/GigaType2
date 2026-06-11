import type { InferenceProvider } from "./types";
import logger from "../../../utils/logger";

export const geminiProvider: InferenceProvider = {
  id: "gemini",
  async call({ model, agentName }) {
    logger.logReasoning("GEMINI_START", { model, agentName });
    throw new Error("Gemini cloud reasoning is disabled");
  },
};
