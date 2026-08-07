/**
 * Single-pass argv parsing shared by the CLI entry points.
 *
 * The tools used to resolve options with `process.argv.indexOf(...)` and
 * `process.argv.includes(...)`, which scans the whole command line with no
 * notion of where positionals begin. Any input path that looked like a flag was
 * therefore honoured as one, and the bridge accepts caller-supplied input
 * paths. Parsing once, and stopping option handling at `--`, closes that.
 */
export function parseArgv(argv, { valueOptions = new Set() } = {}) {
  const command = argv[2];
  const positionals = [];
  const values = new Map();
  const booleans = new Set();
  let terminated = false;

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];

    if (terminated) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      terminated = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!valueOptions.has(arg)) {
        booleans.add(arg);
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value === "--" || value.startsWith("--")) {
        // Catches `--lang --quiet movie.sup`, which previously ran tesseract
        // with the literal language "--quiet".
        throw new Error(`Option ${arg} requires a value.`);
      }
      values.set(arg, value);
      index += 1;
      continue;
    }
    positionals.push(arg);
  }

  return {
    command,
    positionals,
    option(name, fallback = null) {
      return values.get(name) ?? fallback;
    },
    has(name) {
      return booleans.has(name);
    },
    /** Re-emit parsed flags so child processes inherit them without raw argv. */
    flagArgs() {
      const args = [];
      for (const [name, value] of values) args.push(name, value);
      for (const name of booleans) args.push(name);
      return args;
    },
  };
}
