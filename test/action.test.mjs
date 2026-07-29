import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseActionInputs,
  runAction,
  shouldFail,
} from "../action.mjs";

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

test("parses action inputs without an actions toolkit dependency", () => {
  assert.deepEqual(parseActionInputs({ INPUT_URL: "example.com" }), {
    url: "example.com",
    maxLinks: 20,
    timeoutMs: 10_000,
    reportPath: "launch-report.md",
    failOn: "high",
  });

  assert.throws(
    () =>
      parseActionInputs({
        INPUT_URL: "example.com",
        "INPUT_FAIL-ON": "critical",
      }),
    /fail-on/,
  );
  assert.equal(
    shouldFail(
      { blocker: 0, high: 1, medium: 0, low: 0 },
      "high",
    ),
    true,
  );
  assert.equal(
    shouldFail(
      { blocker: 0, high: 1, medium: 0, low: 0 },
      "blocker",
    ),
    false,
  );
});

test("writes a report, job summary, and GitHub Action outputs", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/broken") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      if (request.url === "/robots.txt" || request.url === "/sitemap.xml") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <title>A useful launch page title</title>
            <meta name="description" content="${"A".repeat(80)}">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="canonical" href="/">
            <meta property="og:title" content="Launch page">
            <meta property="og:description" content="Launch page description">
            <meta property="og:image" content="https://example.com/share.png">
            <meta name="twitter:card" content="summary_large_image">
            <link rel="icon" href="/favicon.ico">
          </head>
          <body>
            <h1>Launch page</h1>
            <p>${"Useful launch copy. ".repeat(20)}</p>
            <a href="/broken">Broken link</a>
          </body>
        </html>`);
    },
    async (origin) => {
      const directory = await mkdtemp(join(tmpdir(), "proofdesk-action-"));
      const outputFile = join(directory, "github-output.txt");
      const summaryFile = join(directory, "job-summary.md");
      await writeFile(outputFile, "");
      await writeFile(summaryFile, "");

      try {
        const messages = [];
        const result = await runAction({
          env: {
            INPUT_URL: origin,
            "INPUT_MAX-LINKS": "5",
            "INPUT_TIMEOUT-MS": "2000",
            "INPUT_REPORT-PATH": "reports/launch.md",
            "INPUT_FAIL-ON": "high",
            GITHUB_WORKSPACE: directory,
            GITHUB_OUTPUT: outputFile,
            GITHUB_STEP_SUMMARY: summaryFile,
          },
          stdout: { write: (value) => messages.push(value) },
        });

        assert.equal(result.failed, true);
        assert.equal(result.exitCode, 1);
        assert.match(
          await readFile(result.reportPath, "utf8"),
          /\[HIGH\] Internal links/,
        );
        assert.match(await readFile(summaryFile, "utf8"), /# Launch check/);

        const outputs = await readFile(outputFile, "utf8");
        assert.match(outputs, /result=fail/);
        assert.match(outputs, /blockers=0/);
        assert.match(outputs, /report-path=.*reports[\\/]launch\.md/);
        assert.match(messages.join(""), /Launch check:/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
