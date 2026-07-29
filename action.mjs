#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { scanUrl, toMarkdown } from "./launch-check.mjs";

const DEFAULTS = {
  maxLinks: 20,
  timeoutMs: 10_000,
  reportPath: "launch-report.md",
  failOn: "high",
};
const FAIL_LEVELS = new Set(["blocker", "high", "medium", "low", "never"]);

function input(env, name) {
  const dashed = `INPUT_${name.toUpperCase()}`;
  const underscored = dashed.replaceAll("-", "_");
  return (env[dashed] ?? env[underscored] ?? "").trim();
}

function integerInput(value, name, fallback, minimum, maximum) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `The "${name}" input must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

export function parseActionInputs(env = process.env) {
  const url = input(env, "url");
  if (!url) throw new Error('The "url" input is required.');

  const failOn = input(env, "fail-on").toLowerCase() || DEFAULTS.failOn;
  if (!FAIL_LEVELS.has(failOn)) {
    throw new Error(
      'The "fail-on" input must be blocker, high, medium, low, or never.',
    );
  }

  return {
    url,
    maxLinks: integerInput(
      input(env, "max-links"),
      "max-links",
      DEFAULTS.maxLinks,
      0,
      100,
    ),
    timeoutMs: integerInput(
      input(env, "timeout-ms"),
      "timeout-ms",
      DEFAULTS.timeoutMs,
      100,
      60_000,
    ),
    reportPath: input(env, "report-path") || DEFAULTS.reportPath,
    failOn,
  };
}

export function shouldFail(summary, failOn) {
  const included = {
    blocker: ["blocker"],
    high: ["blocker", "high"],
    medium: ["blocker", "high", "medium"],
    low: ["blocker", "high", "medium", "low"],
    never: [],
  }[failOn];
  return included.some((severity) => summary[severity] > 0);
}

async function appendOutputs(file, values) {
  if (!file) return;
  const lines = Object.entries(values)
    .map(([name, value]) => `${name}=${String(value).replace(/[\r\n]+/g, " ")}`)
    .join("\n");
  await appendFile(file, `${lines}\n`, "utf8");
}

export async function runAction({
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const options = parseActionInputs(env);
  const report = await scanUrl(options.url, {
    maxLinks: options.maxLinks,
    timeoutMs: options.timeoutMs,
  });
  const markdown = toMarkdown(report);
  const workspace = env.GITHUB_WORKSPACE || cwd;
  const reportPath = resolve(workspace, options.reportPath);

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${markdown}\n`, "utf8");
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
  }

  const failed = shouldFail(report.summary, options.failOn);
  await appendOutputs(env.GITHUB_OUTPUT, {
    "report-path": reportPath,
    "final-url": report.finalUrl ?? "",
    result: failed ? "fail" : "pass",
    blockers: report.summary.blocker,
    high: report.summary.high,
    medium: report.summary.medium,
    low: report.summary.low,
    passed: report.summary.passed,
  });

  stdout.write(
    `Launch check: ${report.summary.blocker} blocker, ${report.summary.high} high, ` +
      `${report.summary.medium} medium, ${report.summary.low} low; ` +
      `${report.summary.passed} passed.\nReport: ${reportPath}\n`,
  );

  return { report, reportPath, failed, exitCode: failed ? 1 : 0 };
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  try {
    const result = await runAction();
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`launch-check action: ${error.message}\n`);
    process.exitCode = 1;
  }
}
