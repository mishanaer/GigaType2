import type { InferenceProvider } from "./types";
import logger from "../../../utils/logger";

export const groqProvider: InferenceProvider = {
  id: "groq",
  async call({ model, agentName }) {
    logger.logReasoning("GROQ_START", { model, agentName });
    throw new Error("Groq cloud reasoning is disabled");
  },
};
