import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SlopguardError } from "../core/errors.js";

const LOCK = "lock";
const JOURNAL = "journal.json";
const ORIGINAL = "original";

export interface GuardOptions {
  /** Parent directory of the guard directories. Default: `os.tmpdir()`. */
  tmpRoot?: string;
  /** This process's id. Default: `process.pid`. */
  pid?: number;
  /** Whether a process is alive. Default: a signal-0 probe. */
  isAlive?: (pid: number) => boolean;
}

interface Journal {
  readonly file: string;
  readonly mutantSha256: string;
}

interface CurrentFile {
  readonly path: string;
  readonly original: Buffer;
  readonly atime: Date;
  readonly mtime: Date;
}

/** `withMutant` refused to write: the file no longer holds the bytes the mutants were planned from. */
export class SourceChangedError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`${file} changed while mutate was running`);
    this.name = "SourceChangedError";
    this.file = file;
  }
}

/**
 * Keeps in-place mutation safe. `mutate` edits one source file at a time, and
 * the guard makes sure the original always comes back:
 *
 * - Before a file's first mutant, its bytes are backed up (in memory and in
 *   the guard directory); before each mutant, a journal names the file and
 *   the mutant's sha256. After the test run the original bytes and
 *   timestamps are written back and the journal is deleted.
 * - A `lock` file (exclusive create, holding the pid) allows one run per
 *   project. A lock whose pid is dead belongs to an interrupted run: its
 *   journal is used to restore the file — but only when the file still holds
 *   exactly that mutant, so later edits are never overwritten.
 *
 * The guard directory lives under the OS temp dir, never inside the project,
 * and its layout is shared by every slopguard port that mutates in place.
 *
 * The changed-file check runs only before a mutant is written. An edit saved
 * while the mutant is in the file is overwritten by the restore.
 */
export class WorkspaceGuard {
  readonly directory: string;
  /** Plain-sentence notes from recovering an interrupted run. */
  readonly notes: string[];
  private current: CurrentFile | null = null;
  private mutated = false; // slopguard-ignore-mutant(boolean_literal): nothing reads it before withMutant sets it
  private released = false;

  private constructor(directory: string, notes: string[]) {
    this.directory = directory;
    this.notes = notes;
  }

  /** Take the project's lock, recovering an interrupted run's leftovers first. */
  static acquire(projectRoot: string, options: GuardOptions = {}): WorkspaceGuard {
    const directory = guardDirectory(projectRoot, options.tmpRoot);
    const pid = options.pid ?? process.pid;
    const isAlive = options.isAlive ?? processIsAlive;
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, LOCK);
    if (tryLock(lock, pid)) return new WorkspaceGuard(directory, []);

    const holder = readPid(lock);
    if (holder !== null && holder !== pid && isAlive(holder)) {
      throw SlopguardError.mutationInProgress(holder, projectRoot);
    }
    const notes = recoverInterruptedRun(directory);
    fs.rmSync(lock, { force: true, recursive: true }); // slopguard-ignore-mutant(boolean_literal): force only matters when another run deletes the lock at the same moment
    /* v8 ignore start -- the throw only runs when another run takes the lock between our cleanup and the retry */
    if (!tryLock(lock, pid)) throw SlopguardError.mutationInProgress(readPid(lock) ?? 0, projectRoot);
    /* v8 ignore stop */
    return new WorkspaceGuard(directory, notes);
  }

  /**
   * Write `mutated` into `file`, run `body`, and restore the original —
   * whatever `body` does. The file is backed up before its first mutant.
   * When the file no longer holds `expected` (the bytes the mutants were
   * planned from), someone edited it during the run: nothing is written and
   * `SourceChangedError` is thrown, so the edit survives.
   */
  async withMutant<T>(file: string, expected: Buffer, mutated: Buffer, body: () => Promise<T>): Promise<T> {
    if (!readOrNull(file)?.equals(expected)) throw new SourceChangedError(file);
    if (this.current?.path !== file) this.begin(file);
    writeJson(path.join(this.directory, JOURNAL), { file, mutantSha256: sha256(mutated) });
    this.mutated = true;
    try {
      fs.writeFileSync(file, mutated);
      return await body();
    } finally {
      this.restore();
    }
  }

  /**
   * Put the original back if a mutant is in place. Synchronous, so signal
   * handlers can call it. Returns the restored path, or null.
   */
  restore(): string | null {
    const current = this.current;
    if (current === null || !this.mutated) return null;
    try {
      fs.writeFileSync(current.path, current.original);
      fs.utimesSync(current.path, current.atime, current.mtime);
    } catch (error) {
      throw SlopguardError.restoreFailed(current.path, path.join(this.directory, ORIGINAL), String(error));
    }
    this.mutated = false;
    fs.rmSync(path.join(this.directory, JOURNAL), { force: true }); // slopguard-ignore-mutant(boolean_literal): withMutant always writes the journal first
    return current.path;
  }

  /** Restore anything mutated, then delete the lock, journal and backup. Idempotent. */
  release(): void {
    if (this.released) return;
    this.restore();
    this.released = true;
    for (const name of [JOURNAL, ORIGINAL, LOCK]) {
      fs.rmSync(path.join(this.directory, name), { force: true });
    }
    try {
      fs.rmdirSync(this.directory);
    } catch {
      // Not empty: a kept backup, or another run already took the lock.
    }
  }

  private begin(file: string): void {
    const original = fs.readFileSync(file);
    const stats = fs.statSync(file);
    fs.writeFileSync(path.join(this.directory, ORIGINAL), original);
    this.current = { path: file, original, atime: stats.atime, mtime: stats.mtime };
  }
}

/** `<tmp>/slopguard-mutate/<first 16 hex chars of sha256(real project path)>`. */
export function guardDirectory(projectRoot: string, tmpRoot: string = os.tmpdir()): string {
  let real = path.resolve(projectRoot);
  try {
    real = fs.realpathSync(real);
  } catch {
    // A project root that does not exist yet hashes by its resolved path.
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return path.join(tmpRoot, "slopguard-mutate", hash);
}

function tryLock(lock: string, pid: number): boolean {
  try {
    fs.writeFileSync(lock, String(pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
}

function readPid(lock: string): number | null {
  const text = readOrNull(lock)?.toString("utf8").trim() ?? "";
  return /^\d+$/.test(text) ? Number(text) : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errnoCode(error) === "EPERM";
  }
}

/** Undo what an interrupted run left behind. Returns notes for the report. */
function recoverInterruptedRun(directory: string): string[] {
  const journalPath = path.join(directory, JOURNAL);
  const backupPath = path.join(directory, ORIGINAL);
  const journal = readJournal(journalPath);
  const notes = journal === null ? [] : recoverFile(journal, backupPath, directory);
  fs.rmSync(journalPath, { force: true });
  fs.rmSync(backupPath, { force: true });
  return notes;
}

function recoverFile(journal: Journal, backupPath: string, directory: string): string[] {
  const current = readOrNull(journal.file);
  const backup = readOrNull(backupPath);
  const holdsMutant = current !== null && sha256(current) === journal.mutantSha256;
  if (backup === null) {
    return holdsMutant
      ? [`An interrupted mutate run left ${journal.file} mutated and its backup is missing. Restore the file from version control.`]
      : [];
  }
  if (holdsMutant) {
    fs.writeFileSync(journal.file, backup);
    return [`Restored ${journal.file}, which an interrupted mutate run left mutated.`];
  }
  if (current !== null && current.equals(backup)) return [];
  const kept = path.join(directory, `original-${Date.now()}`);
  fs.renameSync(backupPath, kept);
  return [
    `An interrupted mutate run left a backup of ${journal.file} at ${kept}. The file has changed since, so it was not restored.`,
  ];
}

function readJournal(journalPath: string): Journal | null {
  const raw = readOrNull(journalPath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<Journal>;
    if (typeof parsed.file === "string" && typeof parsed.mutantSha256 === "string") {
      return { file: parsed.file, mutantSha256: parsed.mutantSha256 };
    }
  } catch {
    // A torn journal carries no usable information.
  }
  return null;
}

/** Write via a temp file and rename, so a crash never leaves a half-written journal. */
function writeJson(target: string, value: unknown): void {
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, target);
}

function readOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
