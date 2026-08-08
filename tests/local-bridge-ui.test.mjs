import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

// fetch() forbids overriding the Host header, so a DNS-rebinding request must
// be made with the raw http client.
function rawGet(port, path, headers) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolvePromise({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
import {
  createLocalBridgeServer,
  resolveUiAssetPath,
} from "../lib/local-bridge-server.mjs";

async function withServer(uiRoot, run, options = {}) {
  const server = createLocalBridgeServer({ uiRoot, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, server.sessionToken);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function buildUiRoot() {
  const root = await mkdtemp(join(tmpdir(), "subtitle-workbench-ui-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>Subtitle Workbench</title>");
  await writeFile(join(root, "assets", "index-abc123.js"), "export const ok = true;\n");
  return root;
}

test("never resolves a UI path outside the build directory", () => {
  // resolve() so the containment comparison speaks the platform's own
  // absolute-path dialect ("/tmp/..." becomes "D:\tmp\..." on Windows).
  const root = resolve("/tmp/example-dist");

  // URL parsing already collapses "..", and percent-encoded traversal is
  // decoded before the leading-".." strip, so these land inside the root rather
  // than escaping it. The containment check is the backstop either way: what
  // matters is that no input resolves above `root`.
  const hostile = [
    "/../package.json",
    "/%2e%2e%2fpackage.json",
    "/assets/../../secrets.txt",
    "/....//package.json",
    "/..%2f..%2fetc/passwd",
    "//etc/passwd",
  ];
  for (const requestUrl of hostile) {
    const resolved = resolveUiAssetPath(root, requestUrl);
    if (resolved === null) continue;
    assert.ok(
      resolved === root || resolved.startsWith(root + sep),
      `${requestUrl} escaped the build directory: ${resolved}`,
    );
  }

  assert.equal(
    resolveUiAssetPath(root, "/assets/index.js"),
    join(root, "assets", "index.js"),
  );
});

test("a non-loopback Host gets no page and, above all, no token", async () => {
  const root = await buildUiRoot();
  try {
    await withServer(root, async (origin, token) => {
      // DNS rebinding: the request reaches 127.0.0.1 but carries the
      // attacker's hostname. The static path injects the session token into
      // the HTML, so it must refuse before writing any of the body — a 403
      // stapled after the token would still hand it to a same-origin framer.
      const port = new URL(origin).port;
      const response = await rawGet(port, "/", { host: "evil.example" });
      assert.equal(response.status, 403);
      assert.ok(token, "server should have minted a session token");
      assert.ok(!response.body.includes(token), "response body must not contain the session token");
      assert.ok(
        !response.body.includes("__SUBTITLE_WORKBENCH_TOKEN__"),
        "no token scaffold either",
      );
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("serves the built UI and keeps the API reachable", async () => {
  const uiRoot = await buildUiRoot();
  try {
    await withServer(uiRoot, async (origin, token) => {
      const page = await fetch(`${origin}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html\b/);
      assert.match(await page.text(), /<title>Subtitle Workbench<\/title>/);

      const asset = await fetch(`${origin}/assets/index-abc123.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);

      // The API must not be shadowed by the static handler.
      const health = await fetch(`${origin}/health`, {
        headers: { "x-subtitle-workbench-token": token },
      });
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
    });
  } finally {
    await rm(uiRoot, { force: true, recursive: true });
  }
});

test("does not serve files from outside the build directory over HTTP", async () => {
  const uiRoot = await buildUiRoot();
  try {
    await withServer(uiRoot, async (origin, token) => {
      for (const path of ["/../package.json", "/%2e%2e%2fpackage.json"]) {
        const response = await fetch(`${origin}${path}`, {
          headers: { "x-subtitle-workbench-token": token },
        });
        assert.equal(response.status, 404, `${path} should not be served`);
        assert.doesNotMatch(await response.text(), /subtitle-workbench/);
      }
    });
  } finally {
    await rm(uiRoot, { force: true, recursive: true });
  }
});

test("falls back to the SPA entry for extensionless routes only", async () => {
  const uiRoot = await buildUiRoot();
  try {
    await withServer(uiRoot, async (origin, token) => {
      const route = await fetch(`${origin}/some/client/route`);
      assert.equal(route.status, 200);
      assert.match(await route.text(), /<title>Subtitle Workbench<\/title>/);

      // A missing asset must 404 rather than silently returning HTML, which
      // would otherwise surface as a confusing JS parse error in the browser.
      const missing = await fetch(`${origin}/assets/missing.js`, {
        headers: { "x-subtitle-workbench-token": token },
      });
      assert.equal(missing.status, 404);
    });
  } finally {
    await rm(uiRoot, { force: true, recursive: true });
  }
});
