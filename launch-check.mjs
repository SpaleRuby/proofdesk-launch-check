#!/usr/bin/env node

const USER_AGENT =
  "ProofDesk-Launch-Check/0.1 (+https://github.com/SpaleRuby/proofdesk-launch-check)";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LINKS = 20;
const MAX_HTML_BYTES = 2_000_000;

function decodeHtml(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .trim();
}

function stripTags(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(
      `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` +
        "`" +
        `]+))`,
      "i",
    ),
  );
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function tags(html, tagName) {
  return html.match(new RegExp(`<${tagName}\\b[^>]*>`, "gi")) ?? [];
}

function firstMeta(html, key, attributeName = "name") {
  const target = key.toLowerCase();
  for (const tag of tags(html, "meta")) {
    if (attribute(tag, attributeName).toLowerCase() === target) {
      return attribute(tag, "content");
    }
  }
  return "";
}

function firstLink(html, rel) {
  const target = rel.toLowerCase();
  for (const tag of tags(html, "link")) {
    const rels = attribute(tag, "rel")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (rels.includes(target)) return attribute(tag, "href");
  }
  return "";
}

function firstTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(match?.[1] ?? "");
}

function bodyText(html) {
  return stripTags(
    html
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " "),
  );
}

function normalizeInput(input) {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(withScheme);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  url.hash = "";
  return url;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      ...options.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function fetchDocument(url, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_HTML_BYTES) {
    throw new Error(
      `Document is ${declaredLength} bytes; the document-size limit is ${MAX_HTML_BYTES}.`,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_HTML_BYTES) {
    throw new Error(`Document exceeds the ${MAX_HTML_BYTES}-byte document-size limit.`);
  }
  return {
    response,
    html: text,
    contentType,
    finalUrl: new URL(response.url),
  };
}

async function lightweightStatus(url, timeoutMs) {
  try {
    let response = await fetchWithTimeout(url, { method: "HEAD" }, timeoutMs);
    if ([403, 405, 501].includes(response.status)) {
      response = await fetchWithTimeout(
        url,
        { method: "GET", headers: { range: "bytes=0-0" } },
        timeoutMs,
      );
      await response.body?.cancel();
    }
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      finalUrl: response.url,
    };
  } catch (error) {
    return { ok: false, status: null, error: error.message, finalUrl: null };
  }
}

function collectInternalLinks(html, baseUrl, maxLinks) {
  if (maxLinks === 0) return [];
  const links = [];
  const seen = new Set();
  for (const tag of tags(html, "a")) {
    const href = attribute(tag, "href");
    if (
      !href ||
      href.startsWith("#") ||
      /^(mailto|tel|javascript|data):/i.test(href)
    ) {
      continue;
    }
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      if (url.origin !== baseUrl.origin || seen.has(url.href)) continue;
      seen.add(url.href);
      links.push(url);
      if (links.length >= maxLinks) break;
    } catch {
      // Malformed hrefs are reported separately below.
    }
  }
  return links;
}

function collectMalformedLinks(html, baseUrl) {
  const malformed = [];
  for (const tag of tags(html, "a")) {
    const href = attribute(tag, "href");
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try {
      new URL(href, baseUrl);
    } catch {
      malformed.push(href);
    }
  }
  return [...new Set(malformed)];
}

export async function scanUrl(input, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLinks = options.maxLinks ?? DEFAULT_MAX_LINKS;
  const requestedUrl = normalizeInput(input);
  const checkedAt = new Date().toISOString();
  const findings = [];
  const passes = [];

  const add = (severity, check, observed, recommendation) => {
    findings.push({ severity, check, observed, recommendation });
  };
  const pass = (check, observed) => passes.push({ check, observed });

  let document;
  try {
    document = await fetchDocument(requestedUrl, timeoutMs);
  } catch (error) {
    add(
      "blocker",
      "Page fetch",
      error.message,
      "Make the launch URL publicly reachable and return an HTML response.",
    );
    return {
      requestedUrl: requestedUrl.href,
      finalUrl: null,
      checkedAt,
      findings,
      passes,
      linkChecks: [],
      summary: { blocker: 1, high: 0, medium: 0, low: 0, passed: 0 },
    };
  }

  const { response, html, contentType, finalUrl } = document;

  if (response.status >= 200 && response.status < 300) {
    pass("HTTP status", `${response.status}`);
  } else {
    add(
      "blocker",
      "HTTP status",
      `Launch URL returned ${response.status}.`,
      "Return a stable 2xx response for the canonical launch URL.",
    );
  }

  if (finalUrl.protocol === "https:") {
    pass("HTTPS", finalUrl.href);
  } else {
    add(
      "high",
      "HTTPS",
      `Final URL uses ${finalUrl.protocol}`,
      "Serve and canonicalize the public launch URL over HTTPS.",
    );
  }

  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    pass("Content type", contentType);
  } else {
    add(
      "high",
      "Content type",
      contentType || "No Content-Type header.",
      "Return the landing document with an HTML content type.",
    );
  }

  const title = firstTitle(html);
  if (!title) {
    add("high", "Page title", "No <title> in initial HTML.", "Add a concise page title.");
  } else if (title.length < 10 || title.length > 65) {
    add(
      "low",
      "Page title",
      `${title.length} characters: “${title}”`,
      "Aim for a descriptive title of roughly 10–65 characters.",
    );
  } else {
    pass("Page title", `${title.length} characters`);
  }

  const description = firstMeta(html, "description");
  if (!description) {
    add(
      "medium",
      "Meta description",
      "Missing from initial HTML.",
      "Add a specific summary for search and link previews.",
    );
  } else if (description.length < 50 || description.length > 170) {
    add(
      "low",
      "Meta description",
      `${description.length} characters.`,
      "Use a concrete description of roughly 50–170 characters.",
    );
  } else {
    pass("Meta description", `${description.length} characters`);
  }

  const langTag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const language = attribute(langTag, "lang");
  if (language) pass("Document language", language);
  else
    add(
      "medium",
      "Document language",
      "The <html> element has no lang attribute.",
      "Declare the primary language, for example <html lang=\"en\">.",
    );

  const viewport = firstMeta(html, "viewport");
  if (viewport) pass("Mobile viewport", viewport);
  else
    add(
      "high",
      "Mobile viewport",
      "Missing from initial HTML.",
      "Add a responsive viewport meta tag.",
    );

  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  if (h1Count === 1) pass("Primary heading", "Exactly one <h1>.");
  else
    add(
      "medium",
      "Primary heading",
      `Found ${h1Count} <h1> elements in initial HTML.`,
      "Expose one clear primary heading in the server-returned document.",
    );

  const textLength = bodyText(html).length;
  if (textLength >= 200) pass("Initial page content", `${textLength} text characters`);
  else
    add(
      "medium",
      "Initial page content",
      `Only ${textLength} text characters are present before JavaScript.`,
      "Server-render meaningful launch copy so crawlers and failed scripts still get context.",
    );

  const canonical = firstLink(html, "canonical");
  if (!canonical) {
    add(
      "medium",
      "Canonical URL",
      "No canonical link in initial HTML.",
      "Declare one absolute canonical production URL.",
    );
  } else {
    try {
      const canonicalUrl = new URL(canonical, finalUrl);
      if (canonicalUrl.origin !== finalUrl.origin) {
        add(
          "medium",
          "Canonical URL",
          `Canonical points to another origin: ${canonicalUrl.href}`,
          "Confirm that the canonical origin is intentional.",
        );
      } else {
        pass("Canonical URL", canonicalUrl.href);
      }
    } catch {
      add(
        "medium",
        "Canonical URL",
        `Malformed value: ${canonical}`,
        "Use a valid absolute HTTPS URL.",
      );
    }
  }

  const ogTitle = firstMeta(html, "og:title", "property");
  const ogDescription = firstMeta(html, "og:description", "property");
  const ogImage = firstMeta(html, "og:image", "property");
  const missingOg = [
    !ogTitle && "og:title",
    !ogDescription && "og:description",
    !ogImage && "og:image",
  ].filter(Boolean);
  if (missingOg.length) {
    add(
      "medium",
      "Open Graph preview",
      `Missing ${missingOg.join(", ")}.`,
      "Add explicit title, description, and an absolute share-image URL.",
    );
  } else {
    try {
      const imageUrl = new URL(ogImage, finalUrl);
      if (imageUrl.protocol !== "https:") throw new Error();
      pass("Open Graph preview", "Title, description, and HTTPS image present.");
    } catch {
      add(
        "medium",
        "Open Graph image",
        `Image is not an absolute HTTPS URL: ${ogImage}`,
        "Use an absolute HTTPS image URL, ideally 1200×630.",
      );
    }
  }

  const twitterCard = firstMeta(html, "twitter:card");
  if (twitterCard) pass("Twitter/X card", twitterCard);
  else
    add(
      "low",
      "Twitter/X card",
      "No twitter:card declaration.",
      "Declare summary_large_image or summary for predictable previews.",
    );

  const favicon = firstLink(html, "icon") || firstLink(html, "shortcut");
  if (favicon) pass("Favicon", favicon);
  else
    add(
      "low",
      "Favicon",
      "No icon link found in initial HTML.",
      "Declare a favicon so bookmarks and browser tabs are recognizable.",
    );

  const imageTags = tags(html, "img");
  const missingAlt = imageTags.filter((tag) => !/\balt\s*=/i.test(tag));
  if (!missingAlt.length) {
    pass("Image alt attributes", `${imageTags.length} images checked`);
  } else {
    add(
      "medium",
      "Image alt attributes",
      `${missingAlt.length} of ${imageTags.length} <img> tags omit alt.`,
      "Add meaningful alt text, or alt=\"\" for decorative images.",
    );
  }

  const malformedLinks = collectMalformedLinks(html, finalUrl);
  if (malformedLinks.length) {
    add(
      "high",
      "Malformed links",
      malformedLinks.slice(0, 5).join(", "),
      "Correct href values before launch.",
    );
  } else {
    pass("Link syntax", "No malformed HTTP link values detected.");
  }

  const internalLinks = collectInternalLinks(html, finalUrl, maxLinks);
  const linkChecks = await Promise.all(
    internalLinks.map(async (url) => ({
      url: url.href,
      ...(await lightweightStatus(url, timeoutMs)),
    })),
  );
  const brokenLinks = linkChecks.filter((item) => !item.ok);
  if (brokenLinks.length) {
    add(
      "high",
      "Internal links",
      `${brokenLinks.length} of ${linkChecks.length} checked links failed: ${brokenLinks
        .slice(0, 5)
        .map((item) => `${item.status ?? "ERR"} ${item.url}`)
        .join("; ")}`,
      "Repair or remove broken launch-page links.",
    );
  } else {
    pass("Internal links", `${linkChecks.length} checked; none failed.`);
  }

  const [robots, sitemap] = await Promise.all([
    lightweightStatus(new URL("/robots.txt", finalUrl), timeoutMs),
    lightweightStatus(new URL("/sitemap.xml", finalUrl), timeoutMs),
  ]);
  if (robots.ok) pass("robots.txt", `${robots.status}`);
  else
    add(
      "low",
      "robots.txt",
      robots.error ?? `Returned ${robots.status}.`,
      "Publish a robots.txt with an intentional crawl policy.",
    );
  if (sitemap.ok) pass("sitemap.xml", `${sitemap.status}`);
  else
    add(
      "low",
      "sitemap.xml",
      sitemap.error ?? `Returned ${sitemap.status}.`,
      "Publish a sitemap and reference it from robots.txt.",
    );

  const summary = {
    blocker: findings.filter((item) => item.severity === "blocker").length,
    high: findings.filter((item) => item.severity === "high").length,
    medium: findings.filter((item) => item.severity === "medium").length,
    low: findings.filter((item) => item.severity === "low").length,
    passed: passes.length,
  };

  return {
    requestedUrl: requestedUrl.href,
    finalUrl: finalUrl.href,
    checkedAt,
    findings,
    passes,
    linkChecks,
    summary,
  };
}

export function toMarkdown(report) {
  const lines = [
    "# Launch check",
    "",
    `- Requested: ${report.requestedUrl}`,
    `- Final URL: ${report.finalUrl ?? "unreachable"}`,
    `- Checked: ${report.checkedAt}`,
    `- Findings: ${report.summary.blocker} blocker, ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} low`,
    `- Passed checks: ${report.summary.passed}`,
    "",
  ];

  if (!report.findings.length) {
    lines.push("## Findings", "", "No automated findings.", "");
  } else {
    lines.push("## Findings", "");
    report.findings.forEach((finding, index) => {
      lines.push(
        `### ${index + 1}. [${finding.severity.toUpperCase()}] ${finding.check}`,
        "",
        `**Observed:** ${finding.observed}`,
        "",
        `**Recommendation:** ${finding.recommendation}`,
        "",
      );
    });
  }

  lines.push(
    "## Passed checks",
    "",
    ...report.passes.map((item) => `- **${item.check}:** ${item.observed}`),
    "",
    "---",
    "",
    "Automated checks are evidence, not a complete accessibility, UX, SEO, or conversion review.",
  );
  return lines.join("\n");
}

function parseArguments(args) {
  const options = { json: false, maxLinks: DEFAULT_MAX_LINKS };
  let input = "";
  for (const arg of args) {
    if (arg === "--json") options.json = true;
    else if (arg.startsWith("--max-links=")) {
      const value = Number(arg.slice("--max-links=".length));
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw new Error("--max-links must be an integer from 0 to 100.");
      }
      options.maxLinks = value;
    } else if (!input) input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!input) {
    throw new Error(
      "Usage: node launch-check.mjs <public-url> [--json] [--max-links=20]",
    );
  }
  return { input, options };
}

const isDirectRun =
  process.argv[1] && new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href === import.meta.url;

if (isDirectRun) {
  try {
    const { input, options } = parseArguments(process.argv.slice(2));
    const report = await scanUrl(input, options);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : `${toMarkdown(report)}\n`,
    );
    process.exitCode =
      report.summary.blocker > 0 || report.summary.high > 0 ? 2 : 0;
  } catch (error) {
    process.stderr.write(`launch-check: ${error.message}\n`);
    process.exitCode = 1;
  }
}
