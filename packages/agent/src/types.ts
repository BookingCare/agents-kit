import type { Api, Model, StreamResult, Tool } from "@bookingcare/ai";
import type { SkillLoader } from "./skill-loader.js";

// --- Agent loop ---

export interface AgentLoopOptions {
  model: Model<Api>;
  system?: string;
  tools?: Tool[];
  dispatch?: Record<string, ToolHandler>;
  workdir?: string;
  skillsDir?: string;
  maxTokens?: number;
  maxIterations?: number;
  onStreamResult?: (result: StreamResult, iteration: number) => void;
}

// --- Tools ---

export type ToolHandler = (args: Record<string, unknown>) => string;

export interface ToolDispatch {
  tools: Tool[];
  dispatch: Record<string, ToolHandler>;
  skillLoader?: SkillLoader;
}

// --- Skill loading ---

export interface SkillMeta {
  name: string;
  description: string;
  [key: string]: string;
}

export interface Skill {
  meta: SkillMeta;
  body: string;
}
