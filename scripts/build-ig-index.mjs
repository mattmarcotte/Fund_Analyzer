/**
 * Builds data/ig-index.json — the slug/name/code map for IG Wealth Management
 * unit trust funds.
 *
 * IG publishes each fund's regulatory documents at a stable, predictable path
 * keyed by an internal fund code (F062, F1234, …). The code appears only on the
 * fund's own page, so this script walks the fund list once and records it. The
 * result is committed, so the running app never crawls ig.ca — it fetches one
 * PDF for the fund the user actually asked for.
 *
 * ig.ca/robots.txt allows these paths (only /client-portal/* and /email/* are
 * disallowed). Requests are serialized with a delay to stay well-mannered.
 *
 * Usage: npm run update-ig
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIST_URL = "https://www.ig.ca/en/investments/solutions/mutual-funds";
const ORIGIN = "https://www.ig.ca";

/** Identify the tool honestly rather than impersonating a browser. */
const USER_AGENT =
  "FundAnalyzer/0.1 (personal portfolio analysis tool; +https://github.com/)";

/** Politeness delay between page fetches. */
const DELAY_MS = 400;

const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../data/ig-index.json",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function main() {
  console.log("Fetching IG fund list…");
  const listHtml = await get(LIST_URL);

  const slugs = [
    ...new Set(
      [...listHtml.matchAll(/href="([^"]*\/mutual-funds\/([a-z0-9-]+))"/g)].map(
        (m) => m[2],
      ),
    ),
  ];

  console.log(`  ${slugs.length} fund pages\n`);

  const funds = [];
  const failures = [];

  for (const [i, slug] of slugs.entries()) {
    const url = `${ORIGIN}/en/investments/solutions/mutual-funds/${slug}`;
    process.stdout.write(`  [${i + 1}/${slugs.length}] ${slug} … `);

    try {
      const html = await get(url);

      const code = /fund-financial-statements\/(?:annual|interim)\/([A-Z0-9]+)\.pdf/.exec(
        html,
      )?.[1];

      // The <title> is the cleanest source of the display name.
      const name = decode(
        /<title>([^<]+)<\/title>/.exec(html)?.[1]?.replace(/\s*\|.*$/, "") ?? "",
      );

      if (!code) {
        console.log("no fund code");
        failures.push(slug);
      } else {
        funds.push({ slug, name: name || slug, code });
        console.log(`${code}  ${name}`);
      }
    } catch (err) {
      console.log(`failed (${err.message})`);
      failures.push(slug);
    }

    await sleep(DELAY_MS);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: LIST_URL,
    funds: funds.sort((a, b) => a.name.localeCompare(b.name)),
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2));

  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`  ${funds.length} funds indexed`);
  if (failures.length) {
    console.log(`  ${failures.length} without a code: ${failures.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
