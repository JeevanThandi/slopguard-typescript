import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardDirectory, SourceChangedError, WorkspaceGuard } from "../src/mutation/workspaceGuard.js";

const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text)).digest("hex");

let root: string;
let project: string;
let tmpRoot: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "slopguard-guard-"));
  project = path.join(root, "project");
  tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(tmpRoot);
  file = path.join(project, "src", "a.ts");
  fs.writeFileSync(file, "original");
  fs.utimesSync(file, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-02T00:00:00Z"));
});

afterEach(() => {
  fs.chmodSync(file, 0o644);
  fs.rmSync(root, { recursive: true, force: true });
});

const acquire = (options: { pid?: number; isAlive?: (pid: number) => boolean } = {}) =>
  WorkspaceGuard.acquire(project, { tmpRoot, ...options });

/** Leave behind what a run killed mid-mutant would: lock, journal and backup. */
function interruptedRun(options: { current: string; mutant?: string; backup?: string | null; journal?: string }) {
  const dir = guardDirectory(project, tmpRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lock"), "999999");
  const mutant = options.mutant ?? "mutant";
  fs.writeFileSync(
    path.join(dir, "journal.json"),
    options.journal ?? JSON.stringify({ file, mutantSha256: sha256(mutant) })
  );
  if (options.backup !== null) fs.writeFileSync(path.join(dir, "original"), options.backup ?? "original");
  fs.writeFileSync(file, options.current);
  return dir;
}

describe("guardDirectory", () => {
  it("hashes the real project path under slopguard-mutate", () => {
    const dir = guardDirectory(project, tmpRoot);
    expect(path.dirname(dir)).toBe(path.join(tmpRoot, "slopguard-mutate"));
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/);
    expect(guardDirectory(path.join(project, "src", ".."), tmpRoot)).toBe(dir);
  });

  it("falls back to the resolved path for a missing project and defaults to the OS temp dir", () => {
    const missing = guardDirectory(path.join(root, "nope"));
    expect(missing.startsWith(path.join(os.tmpdir(), "slopguard-mutate"))).toBe(true);
  });
});

describe("WorkspaceGuard", () => {
  it("writes a mutant for the body, restores bytes and timestamps, and cleans up", async () => {
    const guard = acquire();
    const dir = guard.directory;
    expect(fs.readFileSync(path.join(dir, "lock"), "utf8")).toBe(String(process.pid));
    const seen = await guard.withMutant(file, Buffer.from("original"), Buffer.from("mutant"), async () => {
      const journal = JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8"));
      expect(journal).toEqual({ file, mutantSha256: sha256("mutant") });
      expect(fs.readFileSync(path.join(dir, "original"), "utf8")).toBe("original");
      return fs.readFileSync(file, "utf8");
    });
    expect(seen).toBe("mutant");
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(fs.statSync(file).mtime.toISOString()).toBe("2020-01-02T00:00:00.000Z");
    expect(fs.existsSync(path.join(dir, "journal.json"))).toBe(false);
    expect(guard.restore()).toBeNull();
    guard.release();
    guard.release();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("restores when the body throws, and backs up each new file", async () => {
    const other = path.join(project, "src", "b.ts");
    fs.writeFileSync(other, "other");
    const guard = acquire();
    await expect(
      guard.withMutant(file, Buffer.from("original"), Buffer.from("m1"), async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    await guard.withMutant(file, Buffer.from("original"), Buffer.from("m2"), async () => {});
    await guard.withMutant(other, Buffer.from("other"), Buffer.from("m3"), async () => {
      expect(fs.readFileSync(path.join(guard.directory, "original"), "utf8")).toBe("other");
    });
    expect(fs.readFileSync(other, "utf8")).toBe("other");
    guard.release();
  });

  it("refuses to write over a file that changed or vanished since planning", async () => {
    const guard = acquire();
    fs.writeFileSync(file, "edited during the run");
    let ran = false;
    await expect(
      guard.withMutant(file, Buffer.from("original"), Buffer.from("mutant"), async () => {
        ran = true;
      })
    ).rejects.toBeInstanceOf(SourceChangedError);
    expect(ran).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("edited during the run");
    fs.rmSync(file);
    await expect(guard.withMutant(file, Buffer.from("original"), Buffer.from("mutant"), async () => {})).rejects.toThrow(
      `${file} changed while mutate was running`
    );
    fs.writeFileSync(file, "original");
    guard.release();
  });

  it("reports restore_failed and keeps the backup when the original cannot be written", async () => {
    const guard = acquire();
    let caught: unknown;
    try {
      await guard.withMutant(file, Buffer.from("original"), Buffer.from("mutant"), async () => {
        fs.chmodSync(file, 0o444);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "restore_failed" });
    expect(String(caught)).toContain(path.join(guard.directory, "original"));
    expect(() => guard.release()).toThrow(/Could not restore/);
    fs.chmodSync(file, 0o644);
    guard.release();
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });

  it("never releases twice, so a newer run's lock survives", () => {
    const first = acquire();
    first.release();
    const second = acquire();
    first.release();
    expect(fs.readFileSync(path.join(second.directory, "lock"), "utf8")).toBe(String(process.pid));
    second.release();
  });

  it("refuses a second run while the lock holder is alive", () => {
    const first = acquire();
    expect(() => acquire({ pid: 1, isAlive: () => true })).toThrow(/Another slopguard mutate run \(pid \d+\)/);
    first.release();
  });

  it("probes liveness with signal 0 by default", () => {
    const dir = guardDirectory(project, tmpRoot);
    fs.mkdirSync(dir, { recursive: true });
    // The parent process is alive; pid 1 is alive but owned by root (EPERM).
    for (const holder of [process.ppid, 1]) {
      fs.writeFileSync(path.join(dir, "lock"), String(holder));
      expect(() => acquire()).toThrow(/mutate run/);
    }
    fs.writeFileSync(path.join(dir, "lock"), "999999");
    acquire().release();
  });

  it("treats its own pid and a garbled lock as stale", () => {
    const dir = guardDirectory(project, tmpRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "lock"), String(process.pid));
    acquire().release();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "lock"), "not a pid");
    const guard = acquire();
    expect(guard.notes).toEqual([]);
    guard.release();
  });

  it("treats an unreadable lock path as stale", () => {
    const dir = guardDirectory(project, tmpRoot);
    fs.mkdirSync(path.join(dir, "lock"), { recursive: true });
    const guard = acquire();
    expect(fs.readFileSync(path.join(dir, "lock"), "utf8")).toBe(String(process.pid));
    guard.release();
  });

  it("rethrows lock errors other than an existing lock", () => {
    const dir = guardDirectory(project, tmpRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => acquire()).toThrow(/EACCES/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});

describe("WorkspaceGuard recovery of an interrupted run", () => {
  const stale = { isAlive: () => false };

  it("restores a file that still holds the journaled mutant, then clears the journal and backup", () => {
    const dir = interruptedRun({ current: "mutant" });
    const guard = acquire(stale);
    expect(guard.notes).toEqual([`Restored ${file}, which an interrupted mutate run left mutated.`]);
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(fs.existsSync(path.join(dir, "journal.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "original"))).toBe(false);
    guard.release();
  });

  it("keeps the backup, and leaves the file alone, when it changed since", () => {
    const dir = interruptedRun({ current: "edited by hand" });
    const guard = acquire(stale);
    expect(guard.notes).toHaveLength(1);
    expect(guard.notes[0]).toMatch(/left a backup of .* at .*original-\d+\. The file has changed since, so it was not restored\./);
    expect(fs.readFileSync(file, "utf8")).toBe("edited by hand");
    guard.release();
    const kept = fs.readdirSync(dir).filter((name) => name.startsWith("original-"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]!), "utf8")).toBe("original");
  });

  it("says nothing when the file was already restored", () => {
    interruptedRun({ current: "original" });
    const guard = acquire(stale);
    expect(guard.notes).toEqual([]);
    guard.release();
  });

  it("reports a mutated file whose backup is missing", () => {
    interruptedRun({ current: "mutant", backup: null });
    const guard = acquire(stale);
    expect(guard.notes).toEqual([
      `An interrupted mutate run left ${file} mutated and its backup is missing. Restore the file from version control.`,
    ]);
    guard.release();
  });

  it("stays quiet when the backup is missing but the file is not the mutant", () => {
    interruptedRun({ current: "original", backup: null });
    const guard = acquire(stale);
    expect(guard.notes).toEqual([]);
    guard.release();
  });

  it("ignores a torn or incomplete journal, and a missing one", () => {
    interruptedRun({ current: "mutant", journal: "{ torn" });
    let guard = acquire(stale);
    expect(guard.notes).toEqual([]);
    guard.release();
    interruptedRun({ current: "mutant", journal: JSON.stringify({ file }) });
    guard = acquire(stale);
    expect(guard.notes).toEqual([]);
    guard.release();
    const dir = interruptedRun({ current: "mutant" });
    fs.rmSync(path.join(dir, "journal.json"));
    guard = acquire(stale);
    expect(guard.notes).toEqual([]);
    guard.release();
  });
});
