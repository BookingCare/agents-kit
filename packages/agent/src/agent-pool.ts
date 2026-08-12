import { Agent, type AgentOptions } from "./agent.js";

/** Options for constructing an {@link AgentPool}. */
export interface AgentPoolOptions {
  maxAgents?: number;
}

/**
 * Thin in-memory manager for named {@link Agent} instances.
 */
export class AgentPool {
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly options: AgentPoolOptions = {}) {}

  create(agentId: string, options?: AgentOptions): Agent {
    if (this.agents.has(agentId)) {
      throw new Error(`Agent already exists: ${agentId}`);
    }

    if (this.options.maxAgents !== undefined && this.agents.size >= this.options.maxAgents) {
      throw new Error(`Agent pool capacity reached: ${this.options.maxAgents}`);
    }

    const agent = new Agent(options);
    this.agents.set(agentId, agent);
    return agent;
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  list(): Agent[] {
    return Array.from(this.agents.values());
  }

  delete(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  async shutdown(): Promise<void> {
    const agents = this.list();
    const errors: unknown[] = [];

    for (const agent of agents) {
      try {
        await agent.shutdown();
      } catch (error) {
        errors.push(error);
      }
    }

    this.agents.clear();

    if (errors.length > 0) {
      throw errors[0];
    }
  }
}
