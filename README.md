# ProofDesk Launch Check

A zero-dependency, evidence-first check for public launch pages. It catches objective problems before a Product Hunt, Show HN, directory, or customer launch without uploading the URL or report to a third-party dashboard.

```bash
node launch-check.mjs https://example.com > launch-report.md
```

Requires Node.js 20 or newer. Nothing is installed and no account is required.

## What it checks

- reachability, redirects, HTTPS, status, and HTML content type
- title, description, language, viewport, primary heading, and initial HTML copy
- canonical, Open Graph, Twitter/X card, and favicon declarations
- missing image `alt` attributes and malformed links
- up to 20 same-origin links for broken responses
- `robots.txt` and `sitemap.xml`

Use `--json` for machine-readable output or `--max-links=0` to skip link requests:

```bash
node launch-check.mjs https://example.com --json --max-links=10
```

The process exits with code `2` when it finds a blocker or high-severity item, `1` for invalid input/tool failure, and `0` otherwise.

## Why this is deliberately small

Lighthouse, axe, browser testing, security review, copy review, and real user testing solve different problems. This script does not pretend to replace them. It creates a fast, reproducible baseline from the server-returned page and labels its limitations in every Markdown report.

Automated findings can also be false positives. Verify each one before opening an issue or contacting a maintainer.

## Inspect the evidence standard

The broader ProofDesk launch-QA method has produced these public, value-first reports. They are not paid-client claims:

- [GitCharta: missing canonical and social metadata](https://github.com/ThierryRakotomanana/GitCharta/issues/41)
- [BeastLab Multi-LLM: Codex JSONL parser discards successful responses](https://github.com/beastlabai/multi-llm-plugin/issues/2)
- [AgentSnap: setup writes an API key to an unignored `.env`](https://github.com/iamfaham/AgentSnap/issues/2)
- [HNewhere: URL normalization merges case-sensitive resources](https://github.com/twalichiewicz/HNewhere/issues/24)
- [Tokimeter: a weekly Codex limit is labeled as the 5-hour window](https://github.com/toshipepe/tokimeter/issues/20)

Each report contains reproduction evidence, impact, and a proposed correction.

## Run the tests

```bash
npm test
```

## Need the human-readable layer?

[ProofDesk](https://spaleruby.github.io/proofdesk-orders/) offers a $10 introductory launch audit. Payment is due only if the preview contains at least three distinct, reproducible findings. The workflow is transparently AI-assisted, and the report is checked before delivery.

## Responsible use

Scan only public pages you are allowed to request. Keep link limits small, identify the tool through its user agent, and never use findings as pressure, fear, or a fabricated security claim.

MIT licensed.
