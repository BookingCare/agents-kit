// --- Todo tracking ---

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

const MARKERS: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

/**
 * Structured state the LLM writes to for tracking multi-step task progress.
 * Validates constraints: max 20 items, max 1 in_progress, valid statuses.
 */
export class TodoManager {
  private items: TodoItem[] = [];

  /** Replace the entire todo list with validated items. Returns rendered state. */
  update(items: TodoItem[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    let inProgressCount = 0;
    for (const item of items) {
      if (!item.text?.trim()) {
        throw new Error(`Item ${item.id}: text required`);
      }
      if (!MARKERS[item.status]) {
        throw new Error(`Item ${item.id}: invalid status '${item.status}'`);
      }
      if (item.status === "in_progress") {
        inProgressCount++;
      }
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = items;
    return this.render();
  }

  /** Render the current todo list as a formatted string. */
  render(): string {
    if (!this.items.length) return "No todos.";

    const lines = this.items.map((item) => `${MARKERS[item.status]} #${item.id}: ${item.text}`);

    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);

    return lines.join("\n");
  }

  /** Get current items (readonly). */
  getItems(): readonly TodoItem[] {
    return this.items;
  }
}
