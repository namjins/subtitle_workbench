import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv } from "../lib/cli-args.mjs";

const argv = (...args) => ["node", "script.mjs", ...args];

test("stops option parsing at --", () => {
  const cli = parseArgv(argv("sup-to-srt", "--lang", "eng", "--", "--ocr-command"), {
    valueOptions: new Set(["--lang"]),
  });
  assert.equal(cli.command, "sup-to-srt");
  assert.deepEqual(cli.positionals, ["--ocr-command"]);
  assert.equal(cli.option("--ocr-command"), null);
  assert.equal(cli.option("--lang"), "eng");
});

test("refuses an option whose value is another option", () => {
  assert.throws(
    () =>
      parseArgv(argv("sup-to-srt", "--lang", "--quiet", "movie.sup"), {
        valueOptions: new Set(["--lang"]),
      }),
    /requires a value/,
  );
});

test("flagArgs round-trips values and booleans for the child process", () => {
  const cli = parseArgv(argv("sup-to-srt", "--lang", "eng", "--quiet", "movie.sup"), {
    valueOptions: new Set(["--lang"]),
  });
  const child = parseArgv(argv("sup-to-srt", ...cli.flagArgs()), {
    valueOptions: new Set(["--lang"]),
  });
  assert.equal(child.option("--lang"), "eng");
  assert.ok(child.has("--quiet"));
});

test("hasCommand: false starts parsing at argv[2]", () => {
  // benchmark_ocr and extract_missing_sup_images are spawned flag-first, with
  // no subcommand. The command-form parser swallowed their first option.
  const cli = parseArgv(
    argv("--examples-dir", "Subtitle Examples", "--json", "--", "extra.sup"),
    { valueOptions: new Set(["--examples-dir"]), hasCommand: false },
  );
  assert.equal(cli.command, undefined);
  assert.equal(cli.option("--examples-dir"), "Subtitle Examples");
  assert.ok(cli.has("--json"));
  assert.deepEqual(cli.positionals, ["extra.sup"]);
});

test("hasCommand defaults to true and preserves existing behaviour", () => {
  const cli = parseArgv(argv("doctor", "--json"));
  assert.equal(cli.command, "doctor");
  assert.ok(cli.has("--json"));
});

test("classifies the -h and -v literals but no other single-dash token", () => {
  const cli = parseArgv(argv("benchmark-ocr", "-h", "-v", "-0.5", "-x"), {});
  assert.ok(cli.has("-h"));
  assert.ok(cli.has("-v"));
  // Anything else single-dash stays positional so negative numeric option
  // values (e.g. `--tolerance -0.5`) keep working.
  assert.deepEqual(cli.positionals, ["-0.5", "-x"]);
});

test("a negative number survives as a value option's value", () => {
  const cli = parseArgv(argv("x", "--tolerance", "-0.5"), {
    valueOptions: new Set(["--tolerance"]),
  });
  assert.equal(cli.option("--tolerance"), "-0.5");
});
