import { describe, expect, it } from "vitest";
import { matchesAny } from "../src/core/analysis/glob.js";

describe("matchesAny", () => {
  it("matches across path separators like fnmatch without FNM_PATHNAME", () => {
    expect(matchesAny(["**/node_modules/**"], "pkg/node_modules/dep/index.js")).toBe(true);
  });

  it("matches top-level dirs via the leading-slash variant", () => {
    // Without the "/"-prefixed retry, **/dist/** misses a top-level dist/.
    expect(matchesAny(["**/dist/**"], "dist/main.js")).toBe(true);
  });

  it("matches file suffix patterns", () => {
    expect(matchesAny(["**/*.test.*"], "src/foo.test.ts")).toBe(true);
    expect(matchesAny(["**/*.test.*"], "foo.test.ts")).toBe(true);
    expect(matchesAny(["**/*.d.ts"], "types/global.d.ts")).toBe(true);
    expect(matchesAny(["**/*.test.*"], "src/foo.ts")).toBe(false);
  });

  it("supports ? and character classes", () => {
    expect(matchesAny(["file?.ts"], "file1.ts")).toBe(true);
    expect(matchesAny(["file[0-9].ts"], "file7.ts")).toBe(true);
    expect(matchesAny(["file[!0-9].ts"], "file7.ts")).toBe(false);
    expect(matchesAny(["file[!0-9].ts"], "fileA.ts")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(matchesAny(["**/node_modules/**"], "src/modules/foo.ts")).toBe(false);
  });
});
