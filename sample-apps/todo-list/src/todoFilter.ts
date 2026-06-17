import { Todo } from "./todo.js";

export type TodoFilter = "all" | "active" | "completed";

export function applyFilter(todos: Todo[], filter: TodoFilter): Todo[] {
  switch (filter) {
    case "all":
      return todos;
    case "active":
      return todos.filter((t) => !t.completed);
    case "completed":
      return todos.filter((t) => t.completed);
  }
}
