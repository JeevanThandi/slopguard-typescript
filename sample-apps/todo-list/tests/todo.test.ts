import { describe, expect, it } from "vitest";
import { makeTodo, toggle } from "../src/todo.js";
import { applyFilter } from "../src/todoFilter.js";
import { TodoStore } from "../src/todoStore.js";

describe("makeTodo", () => {
  it("defaults to not completed", () => {
    const todo = makeTodo(1, "buy milk");
    expect(todo).toEqual({ id: 1, title: "buy milk", completed: false });
  });

  it("accepts an explicit completed flag", () => {
    expect(makeTodo(2, "done already", true).completed).toBe(true);
  });
});

describe("toggle", () => {
  it("flips completion both ways", () => {
    const todo = makeTodo(1, "a");
    expect(toggle(todo).completed).toBe(true);
    expect(toggle(toggle(todo)).completed).toBe(false);
  });
});

describe("applyFilter", () => {
  const todos = [makeTodo(1, "a"), makeTodo(2, "b", true)];

  it("returns everything for all", () => {
    expect(applyFilter(todos, "all")).toHaveLength(2);
  });

  it("returns only active todos", () => {
    expect(applyFilter(todos, "active").map((t) => t.id)).toEqual([1]);
  });

  it("returns only completed todos", () => {
    expect(applyFilter(todos, "completed").map((t) => t.id)).toEqual([2]);
  });
});

describe("TodoStore", () => {
  it("adds todos with increasing ids", () => {
    const store = new TodoStore();
    expect(store.add("a").id).toBe(1);
    expect(store.add("b").id).toBe(2);
    expect(store.all).toHaveLength(2);
  });

  it("toggles by id", () => {
    const store = new TodoStore();
    const todo = store.add("a");
    store.add("b");
    store.toggle(todo.id);
    expect(store.all[0]!.completed).toBe(true);
    expect(store.all[1]!.completed).toBe(false);
    expect(store.remaining).toBe(1);
  });

  it("removes by id", () => {
    const store = new TodoStore();
    const todo = store.add("a");
    store.remove(todo.id);
    expect(store.all).toHaveLength(0);
    expect(store.remaining).toBe(0);
  });
});
