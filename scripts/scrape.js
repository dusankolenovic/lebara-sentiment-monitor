// Lebara Trustpilot scraper
// Uses Playwright (Chromium) to extract __NEXT_DATA__ from Trustpilot pages.
// Writes normalized JSON to public/data/{source}.json

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SOURCES = [
  {
    id: 'travel',
    label: 'Lebara Travel eSIM',
    url: 'https://www.trustpilot.com/review/travel.lebara.com',
  },
  {
    id: 'mobile',
    label: 'Lebara Mobile UK',
    url: 'https://www.trustpilot.com/review/lebara.com',
  },
];

const PAGES_TO_FETCH = 3;

function computeAggregates(reviews, businessUnit) {
  const total = reviews.length;
  const avgRating =
    total > 0 ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10 : 0;

  const sampled = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  reviews.forEach((r) => {
    const star = Math.min(5, Math.max(1, Math.round(r.rating)));
    sampled[star]++;
  });

  // Prefer business-unit totals (all reviews) over sampled subset
  const bu = businessUnit?.numberOfReviews;
  const buRd = bu
    ? {
        5: bu.fiveStars ?? 0,
        4: bu.fourStars ?? 0,
        3: bu.threeStars ?? 0,
        2: bu.twoStars ?? 0,
        1: bu.oneStar ?? 0,
      }
    : sampled;

  const buTotal = bu?.total || Object.values(buRd).reduce((a, b) => a + b, 0) || total || 1;
  const pct = (n) => Math.round((n / buTotal) * 100);

  const positiveCount = (buRd[5] ?? 0) + (buRd[4] ?? 0);
  const neutralCount = buRd[3] ?? 0;
  const negativeCount = (buRd[2] ?? 0) + (buRd[1] ?? 0);

  return {
    avgRating: businessUnit?.score?.trustScore ?? avgRating,
    totalReviews: bu?.total ?? total,
    sentimentBreakdown: {
      positive: pct(positiveCount),
      neutral: pct(neutralCount),
      negative: pct(negativeCount),
    },
    ratingBreakdown: {
      5: pct(buRd[5] ?? 0),
      4: pct(buRd[4] ?? 0),
      3: pct(buRd[3] ?? 0),
      2: pct(buRd[2] ?? 0),
      1: pct(buRd[1] ?? 0),
    },
  };
}

function normalizeReview(r, sourceId) {
  return {
    id: r.id || `${sourceId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: r.title || '',
    body: r.text || r.body || '',
    rating: Number(r.rating) || 3,
    author: r.consumer?.displayName || r.author || 'Anonymous',
    date: r.dates?.publishedDate || r.date || new Date().toISOString(),
    url: r.id ? `https://www.trustpilot.com/reviews/${r.id}` : '',
  };
}

async function scrapeSource(page, source) {
  const reviews = [];
  let businessUnit = null;

  for (let pageNum = 1; pageNum <= PAGES_TO_FETCH; pageNum++) {
    const url = pageNum === 1 ? source.url : `${source.url}?page=${pageNum}`;
    console.log(`  Fetching ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('#__NEXT_DATA__', { timeout: 15000 });
    } catch (err) {
      console.warn(`  Could not load page ${pageNum}: ${err.message}`);
      break;
    }

    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      try {
        return el ? JSON.parse(el.textContent) : null;
      } catch {
        return null;
      }
    });

    if (!nextData) {
      console.warn(`  No __NEXT_DATA__ on page ${pageNum}`);
      break;
    }

    const pageProps = nextData?.props?.pageProps ?? {};

    if (!businessUnit && pageProps.businessUnit) {
      businessUnit = pageProps.businessUnit;
    }

    const pageReviews = pageProps.reviews ?? [];
    if (pageReviews.length === 0) {
      console.log(`  No reviews on page ${pageNum} — dumping debug snapshot`);
      // Write full nextData so we can inspect the real structure after CI runs
      const debugPath = path.join(outDir, `debug-${source.id}-p${pageNum}.json`);
      fs.writeFileSync(debugPath, JSON.stringify(nextData, null, 2));
      console.log(`  Debug snapshot written to ${debugPath}`);
      break;
    }

    for (const r of pageReviews) {
      reviews.push(normalizeReview(r, source.id));
    }

    console.log(`  Page ${pageNum}: +${pageReviews.length} reviews`);
  }

  const aggregates = computeAggregates(reviews, businessUnit);

  return {
    source: source.id,
    label: source.label,
    ...aggregates,
    reviews,
    fetchedAt: new Date().toISOString(),
  };
}

async function main() {
  console.log('Starting Trustpilot scrape...\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  });

  const page = await context.newPage();
  const outDir = path.join(__dirname, '..', 'public', 'data');
  fs.mkdirSync(outDir, { recursive: true });

  for (const source of SOURCES) {
    console.log(`\n── Scraping ${source.label} ──`);
    try {
      const data = await scrapeSource(page, source);
      const outPath = path.join(outDir, `${source.id}.json`);
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
      console.log(
        `✓ ${source.id}: ${data.reviews.length} reviews scraped, avg ${data.avgRating}★, ` +
          `${data.totalReviews} total on Trustpilot`
      );
    } catch (err) {
      console.error(`✗ ${source.id} failed: ${err.message}`);
      process.exitCode = 1;
    }
  }

  await browser.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
