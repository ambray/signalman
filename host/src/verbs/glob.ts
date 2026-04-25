/**
 * Tiny glob matcher for `signalman.list` `pattern:` filtering.
 *
 * Avoids pulling in `minimatch` for what is, in practice, just `*` and
 * `?` matching against scenario ids. Supports:
 *   - `*` matches zero or more characters except `/`
 *   - `**` matches zero or more characters including `/`
 *   - `?` matches exactly one character
 *
 * Anything more sophisticated (brace expansion, character classes)
 * isn't needed yet — the agent surface uses ids like
 * `example/v2/network-egress`, and `example/**` plus `*-egress` are the
 * only patterns we expect in the wild.
 */

export function minimatch(value: string, pattern: string): boolean {
  // Translate the glob to a regex.
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (/[.+^$(){}|[\]\\]/.test(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re).test(value);
}
