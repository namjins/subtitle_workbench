import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import {
  checkRequestAuthorization,
  createLocalBridgeServer,
} from "../lib/local-bridge-server.mjs";

// fetch() refuses to send a body shorter than its content-length header, so a
// "claims 300 MB, sends 7 bytes" request must be made with the raw http client.
function rawPost(port, path, headers, body) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        let received = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (received += chunk));
        res.on("end", () => resolvePromise({ status: res.statusCode, body: received }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function withServer(run, options = {}) {
  const server = createLocalBridgeServer({ uiRoot: null, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, server.sessionToken);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jobBody(extra = {}) {
  return JSON.stringify({
    command: "sup-to-srt",
    inputs: ["/tmp/movie.sup"],
    ...extra,
  });
}

test("rejects the drive-by CSRF request that used to run a job", async () => {
  await withServer(async (origin) => {
    // Exactly what a hostile page could send: a "simple" cross-origin POST
    // with a text/plain body, which needs no preflight. This used to start a
    // job; CORS response headers never prevented the side effect.
    const response = await fetch(`${origin}/jobs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: jobBody({ ocrEngine: "external-command", ocrCommand: "/bin/sh" }),
    });

    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /token/iu);
  });
});

test("rejects a foreign Origin even with a valid token", async () => {
  await withServer(async (origin, token) => {
    const response = await fetch(`${origin}/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subtitle-workbench-token": token,
        origin: "https://evil.example",
      },
      body: jobBody(),
    });

    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /cross-origin/iu);
  });
});

test("rejects a non-loopback Host header", () => {
  // DNS rebinding: the request reaches 127.0.0.1 but carries the attacker's
  // hostname, which the browser will not let the page forge.
  const denial = checkRequestAuthorization(
    { headers: { host: "evil.example", "x-subtitle-workbench-token": "t" } },
    { token: "t" },
  );
  assert.equal(denial?.status, 403);
  assert.match(denial.message, /loopback/iu);
});

test("rejects a non-JSON content type on JSON endpoints", async () => {
  await withServer(async (origin, token) => {
    const response = await fetch(`${origin}/videos/inspect`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-subtitle-workbench-token": token,
      },
      body: JSON.stringify({ input: "/tmp/movie.mkv" }),
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /application\/json/iu);
  });
});

test("accepts a same-origin request carrying the session token", async () => {
  await withServer(async (origin, token) => {
    const response = await fetch(`${origin}/health`, {
      headers: {
        "x-subtitle-workbench-token": token,
        origin,
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("accepts an allowlisted dev origin only when configured", async () => {
  const devOrigin = "http://127.0.0.1:3000";
  const request = {
    headers: { host: "127.0.0.1:8765", origin: devOrigin, "x-subtitle-workbench-token": "t" },
  };

  assert.equal(checkRequestAuthorization(request, { token: "t" })?.status, 403);
  assert.equal(
    checkRequestAuthorization(request, { token: "t", devOrigins: [devOrigin] }),
    null,
  );
});

test("rejects extract requests with an injected track id or codec", async () => {
  await withServer(async (origin, token) => {
    const send = (tracks) =>
      fetch(`${origin}/videos/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-subtitle-workbench-token": token,
        },
        body: JSON.stringify({ input: "/tmp/movie.mkv", tracks }),
      });

    // trackId is interpolated into mkvextract's "<id>:<path>" spec.
    const badId = await send([{ trackId: "0:/etc/passwd", codec: "S_VOBSUB" }]);
    assert.equal(badId.status, 400);

    // languageCode is interpolated into the output filename.
    const badLang = await send([
      { trackId: 2, codec: "S_VOBSUB", languageCode: "../../../etc/x" },
    ]);
    assert.equal(badLang.status, 400);

    const badCodec = await send([{ trackId: 2, codec: "S_NOPE" }]);
    assert.equal(badCodec.status, 400);
  });
});

test("rejects an oversized upload from its declared length before buffering", async () => {
  await withServer(async (origin, token) => {
    // Content-length claims 300 MB (over the 256 MB cap); the actual body is a
    // few bytes. The request must be refused from the header before the body is
    // read, so nothing large is ever held in memory.
    const port = new URL(origin).port;
    const response = await rawPost(
      port,
      "/uploads",
      {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(300 * 1024 * 1024),
        "x-subtitle-workbench-token": token,
      },
      "--x--\r\n",
    );
    assert.equal(response.status, 400);
    assert.match(JSON.parse(response.body).error, /too large/iu);
  });
});

test("serves the dependency report to authorized callers only", async () => {
  await withServer(async (origin, token) => {
    // No token: the report fingerprints the machine (installed tools,
    // platform), so it is gated like everything else.
    const denied = await fetch(`${origin}/doctor`, {
      headers: { Host: new URL(origin).host },
    });
    assert.notEqual(denied.status, 200);

    const allowed = await fetch(`${origin}/doctor`, {
      headers: {
        Host: new URL(origin).host,
        "x-subtitle-workbench-token": token,
      },
    });
    assert.equal(allowed.status, 200);
    const report = await allowed.json();
    assert.equal(typeof report.summary.ready, "boolean");
    assert.ok(Array.isArray(report.install));
  });
});
