/**
 * Minimal glob matcher replicating slopguard-swift's `fnmatch` semantics
 * (FNM_PATHNAME *off*): `*` matches across path separators — which is the
 * behavior most people expect from `**`-style globs ("everything under
 * node_modules"). `?` matches one character; `[...]` character classes pass
 * through (`[!...]` negates).
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "?") {
      out += ".";
      i += 1;
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 2); // a class is never empty: "[]]" matches "]"
      if (close < 0) {
        out += "\\[";
        i += 1;
      } else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close + 1;
      }
    } else {
      out += ch.replace(/[.+^${}()|\\\/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(out + "$");
}

/**
 * Match the relative path against each glob, also trying a leading-slash
 * variant. Without this, `**​/Foo/**` patterns fail to match a top-level
 * `Foo/bar.ts` because `*` needs a separator to anchor against — matching
 * gitignore semantics where a leading `**​/` is effectively implicit.
 */
export function matchesAny(globs: readonly string[], path: string): boolean {
  const withSlash = "/" + path;
  for (const g of globs) {
    const re = compiled(g);
    if (re.test(path) || re.test(withSlash)) return true;
  }
  return false;
}

const cache = new Map<string, RegExp>();

function compiled(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re;
}
