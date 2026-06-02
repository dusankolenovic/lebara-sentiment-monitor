// Lebara Trustpilot scraper — uses Firecrawl to render pages, extracts __NEXT_DATA__
const fs = require('fs');
const path = require('path');

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const FIRECRAWL_URL = 'https://api.firecrawl.dev/v1/scrape';

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

async function fetchRenderedHtml(url) {
  const res = await fetch(FIRECRAWL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['rawHtml'] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firecrawl ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json?.data?.rawHtml ?? json?.data?.html ?? '';
}

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function computeAggregates(reviews, businessUnit) {
  const total = reviews.length;
  const avgRating =
    total > 0 ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10 : 0;

  const sampled = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  reviews.forEach((r) => {
    const star = Math.min(5, Math.max(1, Math.round(r.rating)));
    sampled[star]++;
  });

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

  return {
    avgRating: businessUnit?.score?.trustScore ?? avgRating,
    totalReviews: bu?.total ?? total,
    sentimentBreakdown: {
      positive: pct((buRd[5] ?? 0) + (buRd[4] ?? 0)),
      neutral: pct(buRd[3] ?? 0),
      negative: pct((buRd[2] ?? 0) + (buRd[1] ?? 0)),
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

async function scrapeSource(source, outDir) {
  const reviews = [];
  let businessUnit = null;

  for (let pageNum = 1; pageNum <= PAGES_TO_FETCH; pageNum++) {
    const url = pageNum === 1 ? source.url : `${source.url}?page=${pageNum}`;
    console.log(`  Fetching ${url}`);

    let html;
    try {
      html = await fetchRenderedHtml(url);
    } catch (err) {
      console.warn(`  Firecrawl error on page ${pageNum}: ${err.message}`);
      break;
    }

    const nextData = extractNextData(html);

    if (!nextData) {
      console.warn(`  No __NEXT_DATA__ on page ${pageNum} — writing debug snapshot`);
      fs.writeFileSync(
        path.join(outDir, `debug-${source.id}-p${pageNum}.html`),
        html.slice(0, 50000)
      );
      break;
    }

    const pageProps = nextData?.props?.pageProps ?? {};

    if (!businessUnit && pageProps.businessUnit) {
      businessUnit = pageProps.businessUnit;
    }

    const pageReviews = pageProps.reviews ?? [];
    if (pageReviews.length === 0) {
      console.log(`  No reviews on page ${pageNum} — writing debug snapshot`);
      fs.writeFileSync(
        path.join(outDir, `debug-${source.id}-p${pageNum}.json`),
        JSON.stringify(nextData, null, 2)
      );
      break;
    }

    for (const r of pageReviews) {
      reviews.push(normalizeReview(r, source.id));
    }
    console.log(`  Page ${pageNum}: +${pageReviews.length} reviews`);
  }

  return {
    source: source.id,
    label: source.label,
    ...computeAggregates(reviews, businessUnit),
    reviews,
    fetchedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!FIRECRAWL_API_KEY) {
    console.error('FIRECRAWL_API_KEY env var is not set');
    process.exit(1);
  }

  console.log('Starting Trustpilot scrape via Firecrawl...\n');

  const outDir = path.join(__dirname, '..', 'public', 'data');
  fs.mkdirSync(outDir, { recursive: true });

  for (const source of SOURCES) {
    console.log(`\n── Scraping ${source.label} ──`);
    try {
      const data = await scrapeSource(source, outDir);
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

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
