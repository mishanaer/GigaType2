import { useState } from "react";

const AGENT_NAME_KEY = "agentName";
const DEFAULT_AGENT_NAME = "GigaType";

export const getAgentName = (): string => {
  return localStorage.getItem(AGENT_NAME_KEY) || DEFAULT_AGENT_NAME;
};

export const setAgentName = (name: string): void => {
  const trimmed = name.trim() || DEFAULT_AGENT_NAME;
  localStorage.setItem(AGENT_NAME_KEY, trimmed);
};

export const useAgentName = () => {
  const [agentName, setAgentNameState] = useState<string>(getAgentName());

  const updateAgentName = (name: string) => {
    setAgentName(name);
    setAgentNameState(name.trim() || DEFAULT_AGENT_NAME);
  };

  return { agentName, setAgentName: updateAgentName };
};
