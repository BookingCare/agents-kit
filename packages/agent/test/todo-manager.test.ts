import { describe, it, expect } from "vitest";
import { TodoManager } from "../src/todo-manager.js";

describe("TodoManager", () => {
  describe("update", () => {
    it("accepts a valid list of items", () => {
      const mgr = new TodoManager();
      const result = mgr.update([
        { id: "1", text: "Plan the feature", status: "completed" },
        { id: "2", text: "Write code", status: "in_progress" },
        { id: "3", text: "Write tests", status: "pending" },
      ]);

      expect(result).toContain("[x] #1: Plan the feature");
      expect(result).toContain("[>] #2: Write code");
      expect(result).toContain("[ ] #3: Write tests");
      expect(result).toContain("(1/3 completed)");
    });

    it("rejects empty items list", () => {
      const mgr = new TodoManager();
      const result = mgr.update([]);
      expect(result).toBe("No todos.");
    });

    it("rejects items without text", () => {
      const mgr = new TodoManager();
      expect(() => mgr.update([{ id: "1", text: "", status: "pending" }])).toThrow("text required");
    });

    it("rejects items with whitespace-only text", () => {
      const mgr = new TodoManager();
      expect(() => mgr.update([{ id: "1", text: "   ", status: "pending" }])).toThrow(
        "text required",
      );
    });

    it("rejects invalid status", () => {
      const mgr = new TodoManager();
      expect(() => mgr.update([{ id: "1", text: "Task", status: "unknown" } as any])).toThrow(
        "invalid status",
      );
    });

    it("rejects more than one in_progress item", () => {
      const mgr = new TodoManager();
      expect(() =>
        mgr.update([
          { id: "1", text: "Task A", status: "in_progress" },
          { id: "2", text: "Task B", status: "in_progress" },
        ]),
      ).toThrow("Only one task can be in_progress at a time");
    });

    it("rejects more than 20 items", () => {
      const mgr = new TodoManager();
      const items = Array.from({ length: 21 }, (_, i) => ({
        id: String(i + 1),
        text: `Task ${i + 1}`,
        status: "pending" as const,
      }));
      expect(() => mgr.update(items)).toThrow("Max 20 todos allowed");
    });

    it("allows exactly 20 items", () => {
      const mgr = new TodoManager();
      const items = Array.from({ length: 20 }, (_, i) => ({
        id: String(i + 1),
        text: `Task ${i + 1}`,
        status: "pending" as const,
      }));
      const result = mgr.update(items);
      expect(result).toContain("(0/20 completed)");
    });
  });

  describe("render", () => {
    it("returns 'No todos.' when empty", () => {
      const mgr = new TodoManager();
      expect(mgr.render()).toBe("No todos.");
    });

    it("shows correct markers for each status", () => {
      const mgr = new TodoManager();
      mgr.update([
        { id: "1", text: "Pending task", status: "pending" },
        { id: "2", text: "Active task", status: "in_progress" },
        { id: "3", text: "Done task", status: "completed" },
      ]);

      const rendered = mgr.render();
      expect(rendered).toContain("[ ] #1: Pending task");
      expect(rendered).toContain("[>] #2: Active task");
      expect(rendered).toContain("[x] #3: Done task");
      expect(rendered).toContain("(1/3 completed)");
    });
  });

  describe("getItems", () => {
    it("returns empty array initially", () => {
      const mgr = new TodoManager();
      expect(mgr.getItems()).toEqual([]);
    });

    it("returns current items after update", () => {
      const mgr = new TodoManager();
      const items = [
        { id: "1", text: "Task 1", status: "pending" as const },
        { id: "2", text: "Task 2", status: "completed" as const },
      ];
      mgr.update(items);
      expect(mgr.getItems()).toEqual(items);
    });

    it("replaces items on subsequent update", () => {
      const mgr = new TodoManager();
      mgr.update([{ id: "1", text: "Old", status: "pending" }]);
      mgr.update([{ id: "2", text: "New", status: "in_progress" }]);

      expect(mgr.getItems()).toEqual([{ id: "2", text: "New", status: "in_progress" }]);
    });
  });
});
