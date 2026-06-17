import { makeTodo, Todo, toggle } from "./todo.js";

export class TodoStore {
  private todos: Todo[] = [];
  private nextId = 1;

  add(title: string): Todo {
    const todo = makeTodo(this.nextId, title);
    this.nextId += 1;
    this.todos = [...this.todos, todo];
    return todo;
  }

  toggle(id: number): void {
    this.todos = this.todos.map((t) => (t.id === id ? toggle(t) : t));
  }

  remove(id: number): void {
    this.todos = this.todos.filter((t) => t.id !== id);
  }

  get all(): Todo[] {
    return [...this.todos];
  }

  get remaining(): number {
    return this.todos.filter((t) => !t.completed).length;
  }
}
