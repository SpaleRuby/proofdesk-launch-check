import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { scanUrl, toMarkdown } from "../launch-check.mjs";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("reports objective launch problems and a broken internal link", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/broken") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      if (request.url === "/robots.txt" || request.url === "/sitemap.xml") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Short</title></head>
          <body><a href="/broken">Broken</a><img src="/hero.png"></body>
        </html>`);
    },
    async (origin) => {
      const report = await scanUrl(origin, { maxLinks: 5, timeoutMs: 2_000 });
      const checks = new Set(report.findings.map((finding) => finding.check));

      assert.equal(report.finalUrl, `${origin}/`);
      assert.ok(checks.has("HTTPS"));
      assert.ok(checks.has("Meta description"));
      assert.ok(checks.has("Mobile viewport"));
      assert.ok(checks.has("Primary heading"));
      assert.ok(checks.has("Image alt attributes"));
      assert.ok(checks.has("Internal links"));
      assert.match(toMarkdown(report), /\[HIGH\] Internal links/);
    },
  );
});

test("returns a blocker report instead of throwing when the URL is unreachable", async () => {
  const report = await scanUrl("http://127.0.0.1:1", { timeoutMs: 100 });
  assert.equal(report.finalUrl, null);
  assert.equal(report.summary.blocker, 1);
  assert.equal(report.findings[0].check, "Page fetch");
});
