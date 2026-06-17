import fs from "node:fs";
import path from "node:path";

/**
 * Walks up from a source path looking for the nearest `package.json` — the
 * project root the test runner should execute from when the user hasn't
 * explicitly said otherwise.
 *
 * Treating the analyzed source path as a hint to find the *real* project
 * root means `slopguard-ts analyze --path src` runs the test suite of the
 * package whose `src/` folder that is, not whatever the current working
 * directory happens to be.
 *
 * Returns the nearest existing directory of `searchingFrom` when nothing is
 * found — callers downstream (runner detection) will surface their own
 * error if the directory isn't actually a project.
 */
export function discoverProjectRoot(searchingFrom: string): string {
  let dir = path.resolve(searchingFrom);

  // If the input is a file, climb to its containing directory before starting
  // the walk — markers are siblings, not children, of source files.
  try {
    if (!fs.statSync(dir).isDirectory()) {
      dir = path.dirname(dir);
    }
  } catch {
    dir = path.dirname(dir);
  }

  const fallback = dir;
  // Cap the climb to avoid an infinite loop on broken filesystems. Real
  // project trees are nowhere near 64 levels deep.
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}
