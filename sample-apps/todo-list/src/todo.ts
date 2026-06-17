export interface Todo {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

export function makeTodo(id: number, title: string, completed = false): Todo {
  return { id, title, completed };
}

export function toggle(todo: Todo): Todo {
  return { ...todo, completed: !todo.completed };
}
