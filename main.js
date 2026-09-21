/**
 * Custom Apify Actor: Window Covering Qualifier for Home Automation Stores
 *
 * Goal: confirm whether a home automation / smart home business works with
 * window coverings.
 *
 * DECISION RULES
 *   Tier 1 - Explicit window covering mention (shades, blinds, shutters,
 *            drapery, window treatments, Hunter Douglas, Lutron shade lines...)
 *            -> KEEP (high). 100% approved, no Gemini needed for the decision.
 *   Tier 2 - Only automation/motorization brands from the compatibility list
 *            (Somfy, PowerView, Lutron, Control4, Crestron, Z-Wave, etc.)
 *            -> MAYBE until Gemini confirms:
 *                 Gemini YES     -> KEEP (medium, "gemini-confirmed")
 *                 Gemini UNCLEAR -> MAYBE
 *                 Gemini NO      -> MAYBE (low), or SKIP if skipOnGeminiNo = true
 *   Tier 3 - Nothing found -> SKIP, unless Gemini independently says YES
 *            (then MAYBE for manual review).
 *
 * WHERE IT LOOKS
 *   Body text, nav/link labels + URLs, image alt/title/filenames (logo grids
 *   like "compatible with" walls are usually images), meta tags, schema.org.
 *   Homepage first; if no explicit window-covering mention, it follows the
 *   most relevant internal links (shades/blinds/window pages first, then
 *   services/products/brands, then about) and stops as soon as it finds one.
 *
 * INPUT
 *   urls            (array, required)
 *   geminiApiKey    (string, or GEMINI_API_KEY env var)
 *   maxSubpages     (number, default 4)
 *   skipOnGeminiNo  (boolean, default false)
 *   delayMs         (number, default 1500)
 */

import { Actor } from 'apify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_MODEL = 'gemini-3.5-flash';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------------------------------------------------------------------------
// TIER 1 - Explicit window coverings => KEEP
// Singular "shade"/"blind"/"shutter" only count inside a compound
// ("roller shade", "motorized blind") to avoid "throw shade", "blind spot", etc.
// ---------------------------------------------------------------------------
const WINDOW_COVERING_TERMS = [
  { label: 'window coverings', patterns: [/\bwindow[\s-]+coverings?\b/gi] },
  { label: 'window treatments', patterns: [/\bwindow[\s-]+treatments?\b/gi] },
  { label: 'window fashions', patterns: [/\bwindow[\s-]+fashions?\b/gi] },
  {
    label: 'shades',
    patterns: [
      /\bshades\b/gi,
      /\b(roller|cellular|honeycomb|roman|pleated|woven|solar|blackout|sheer|zebra|motori[sz]ed|automated|smart|exterior|window)[\s-]+shade\b/gi,
    ],
  },
  {
    label: 'blinds',
    patterns: [
      /\bblinds\b/gi,
      /\b(venetian|vertical|horizontal|wood|faux[\s-]wood|mini|motori[sz]ed|automated|smart|window|roller)[\s-]+blind\b/gi,
    ],
  },
  {
    label: 'shutters',
    patterns: [/\bshutters\b/gi, /\b(plantation|interior|motori[sz]ed|window)[\s-]+shutter\b/gi],
  },
  { label: 'drapery', patterns: [/\b(drapes|drapery|draperies)\b/gi] },
  { label: 'curtains', patterns: [/\bcurtains?\b/gi] },
  { label: 'Hunter Douglas', patterns: [/\bhunter[\s-]?douglas\b/gi] },
  { label: 'Graber / Levolor / Norman', patterns: [/\b(graber|levolor|norman[\s-](shutters|window fashions))\b/gi] },
  {
    label: 'Lutron shading (Sivoia / Serena / Palladiom)',
    patterns: [/\b(sivoia|palladiom|serena[\s-](shades|smart shades|remote))\b/gi, /\blutron[\s-](shades|shading)\b/gi],
  },
];

// Phrases stripped out before window-covering matching (false positives)
const FALSE_POSITIVE_PHRASES = [
  /\bshades? of\b/gi,
  /\blamp[\s-]?shades?\b/gi,
  /\bshade[\s-]+(sails?|trees?|structures?|canop(y|ies)|gardens?)\b/gi,
  /\bshutter[\s-]?(speed|stock|fly|bug)s?\b/gi,
  /\bblind[\s-]+(spots?|dates?|trust|faith)\b/gi,
  /\b(colou?r|double|single|triple)[\s-]+blind\b/gi,
  /\bcurtain[\s-]+(walls?|calls?|raisers?)\b/gi,
  /\bbehind the curtain\b/gi,
];

// ---------------------------------------------------------------------------
// TIER 2 - Automation / motorization brands: the 25 logos from the
// "Compatible with virtually every home automation system" graphic, in the
// same order (row by row), plus generic "motorized". => MAYBE until Gemini
// confirms.
//
// strength = how much a mention says about window coverings specifically:
//   'shade'    - shade/blind motorization brand (strong evidence)
//   'control'  - whole-home control system that CAN run shades (moderate)
//   'platform' - generic voice/protocol platform (weak on its own)
//
// Ambiguous names (Bond, Brilliant, Clare, Vantage, Matter, ELAN, RTI, URC,
// Josh) need context words or exact casing so everyday words don't match.
// Product-line names are included because dealers often list those instead
// of the brand (e.g. "RA3", "TaHoma", "Automate Pulse").
// ---------------------------------------------------------------------------
const AUTOMATION_BRANDS = [
  // Row 1: alexa | Apple Home | Bluetooth | bond | brilliant
  { label: 'Amazon Alexa', strength: 'platform', patterns: [/\balexa\b/gi, /\bamazon echo\b/gi] },
  { label: 'Apple Home / HomeKit', strength: 'platform', patterns: [/\bhome ?kit\b/gi, /\bapple home\b/gi, /\bsiri\b/gi] },
  { label: 'Bluetooth', strength: 'platform', patterns: [/\bbluetooth\b/gi] },
  { label: 'Bond', strength: 'shade', patterns: [/\bbond[\s-](bridge|home|hub|pro|logo)\b/gi, /\bbondhome\b/gi] },
  { label: 'Brilliant', strength: 'control', patterns: [/\bbrilliant[\s-](smart|control|nextgen|home control|logo)\b/gi, /\bbrilliant\.tech\b/gi] },

  // Row 2: clare | Control4 | Crestron | ELAN | Google Assistant
  { label: 'Clare Controls', strength: 'control', patterns: [/\bclare[\s-]?(controls|home|one|logo)\b/gi] },
  { label: 'Control4', strength: 'control', patterns: [/\bcontrol[\s-]?4\b/gi, /\bsnap[\s-]?one\b/gi] },
  { label: 'Crestron', strength: 'control', patterns: [/\bcrestron\b/gi] },
  { label: 'ELAN', strength: 'control', patterns: [/\bELAN\b/g, /\belan[\s-](home|control|smart|systems?|logo)\b/gi] },
  { label: 'Google Assistant / Home', strength: 'platform', patterns: [/\bgoogle[\s-](assistant|home|nest)\b/gi, /\bnest[\s-]hub\b/gi] },

  // Row 3: JOSH | linxura | LiteTouch | LOXONE | LUTRON
  { label: 'Josh.ai', strength: 'control', patterns: [/\bjosh[\s.]?ai\b/gi, /\bjosh[\s-](nano|micro|core|logo)\b/gi] },
  { label: 'Linxura', strength: 'control', patterns: [/\blinxura\b/gi] },
  { label: 'LiteTouch', strength: 'control', patterns: [/\blite[\s-]?touch\b/gi] },
  { label: 'Loxone', strength: 'control', patterns: [/\bloxone\b/gi] },
  {
    label: 'Lutron',
    strength: 'control',
    patterns: [/\blutron\b/gi, /\b(radio[\s-]?ra[\s-]?[23]?|ra[\s-]?3|homeworks|caseta|caséta)\b/gi],
  },

  // Row 4: matter | PowerView | Rollease Acmeda | RTI | SAVANT
  {
    label: 'Matter',
    strength: 'platform',
    patterns: [
      /\bmatter[\s-](certified|compatible|enabled|protocol|standard|devices?|support|logo)\b/gi,
      /\b(works with|supports|compatible with) matter\b/gi,
    ],
  },
  { label: 'PowerView (Hunter Douglas)', strength: 'shade', patterns: [/\bpower[\s-]?view\b/gi] },
  {
    label: 'Rollease Acmeda',
    strength: 'shade',
    patterns: [/\brollease\b/gi, /\bacmeda\b/gi, /\bautomate[\s-](pulse|shades?|motors?)\b/gi],
  },
  { label: 'RTI', strength: 'control', patterns: [/\bRTI\b/g, /\brti[\s-](control|logo)\b/gi] },
  { label: 'Savant', strength: 'control', patterns: [/\bsavant\b/gi] },

  // Row 5: somfy | URC | Vantage | Z-Wave | zigbee
  {
    label: 'Somfy',
    strength: 'shade',
    patterns: [/\bsomfy\b/gi, /\btahoma\b/gi, /\bmylink\b/gi, /\bsonesse\b/gi],
  },
  {
    label: 'URC',
    strength: 'control',
    patterns: [/\bURC\b/g, /\buniversal remote control\b/gi, /\btotal control\s?2\.0\b/gi, /\burc[\s-]logo\b/gi],
  },
  { label: 'Vantage', strength: 'control', patterns: [/\bvantage[\s-](controls|lighting|automation|infusion|logo)\b/gi] },
  { label: 'Z-Wave', strength: 'platform', patterns: [/\bz[\s-]?wave\b/gi] },
  { label: 'Zigbee', strength: 'platform', patterns: [/\bzigbee\b/gi] },

  // Not a logo, but any motorization mention is worth checking
  { label: 'Motorization (generic)', strength: 'control', patterns: [/\bmotori[sz](ed|ation)\b/gi] },
];

const BRAND_STRENGTH = Object.fromEntries(AUTOMATION_BRANDS.map((b) => [b.label, b.strength]));
const STRENGTH_RANK = { shade: 3, control: 2, platform: 1 };

function strongestBrandTier(brands) {
  let best = null;
  for (const b of brands) {
    const s = BRAND_STRENGTH[b.label];
    if (!best || STRENGTH_RANK[s] > STRENGTH_RANK[best]) best = s;
  }
  return best;
}

function brandsByTier(brands, tier) {
  return brands.filter((b) => BRAND_STRENGTH[b.label] === tier).map((b) => b.label);
}

// Subpage discovery: higher score = fetched first
const PAGE_PRIORITY = [
  { re: /(shade|blind|shutter|drape|drapery|curtain|window|motori[sz])/i, score: 3 },
  { re: /(service|solution|product|brand|partner|what-we-do|automation|smart-home|lighting|integrat)/i, score: 2 },
  { re: /(about|who-we-are|our-story|company)/i, score: 1 },
];

// Used only when the homepage has no usable links (JS-rendered or fetch failed)
const FALLBACK_PATHS = ['/services', '/motorized-shades', '/shades', '/window-treatments', '/products', '/brands', '/about'];

// ---------------------------------------------------------------------------
// Fetching & extraction
// ---------------------------------------------------------------------------
function describeFetchError(error) {
  if (error.response) return `HTTP ${error.response.status}`;
  if (error.code === 'ECONNABORTED') return 'timeout';
  if (error.code) return error.code;
  return error.message || 'unknown error';
}

async function fetchHtml(url, timeout = 15000) {
  try {
    const res = await axios.get(url, {
      timeout,
      maxRedirects: 5,
      responseType: 'text',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });
    const contentType = res.headers['content-type'] || '';
    if (contentType && !contentType.includes('html')) {
      return { html: null, finalUrl: url, error: `non-HTML (${contentType.split(';')[0]})` };
    }
    return { html: res.data, finalUrl: res.request?.res?.responseUrl || url, error: null };
  } catch (error) {
    return { html: null, finalUrl: url, error: describeFetchError(error) };
  }
}

function extractSchemaText($) {
  const parts = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      items.forEach((item) => {
        const entries = Array.isArray(item?.['@graph']) ? item['@graph'] : [item];
        entries.forEach((e) => {
          if (!e || typeof e !== 'object') return;
          ['name', 'description', 'serviceType', 'knowsAbout', 'slogan'].forEach((k) => {
            if (e[k]) parts.push(typeof e[k] === 'string' ? e[k] : JSON.stringify(e[k]));
          });
        });
      });
    } catch (e) {
      // malformed JSON-LD, skip
    }
  });
  return parts.join(' | ');
}

function pathToWords(pathname) {
  try {
    return decodeURIComponent(pathname).replace(/[-_/]+/g, ' ').trim();
  } catch (e) {
    return pathname.replace(/[-_/]+/g, ' ').trim();
  }
}

function extractPageSignals(html, pageUrl) {
  const $ = cheerio.load(html);

  const metaTitle = $('title').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
  const metaDescription =
    $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  const schemaText = extractSchemaText($);

  // Links (kept before any stripping - nav labels like "Motorized Shades" are strong signals)
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    try {
      const abs = new URL(href, pageUrl);
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      links.push({ href: abs.href, text, pathWords: pathToWords(abs.pathname) });
    } catch (e) {
      // invalid URL
    }
  });
  const linkText = links.map((l) => `${l.text} ${l.pathWords}`.trim()).filter(Boolean).join(' | ');

  // Image alt / title / filename - logo walls are usually images
  const imageBits = [];
  $('img').each((_, el) => {
    const alt = $(el).attr('alt') || '';
    const title = $(el).attr('title') || '';
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
    const file = (src.split('?')[0].split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ');
    const combined = [alt, title, file].filter(Boolean).join(' ');
    if (combined) imageBits.push(combined);
  });
  const imageText = imageBits.join(' | ');

  $('script, style, noscript, svg').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 25000);

  let path = '/';
  try {
    path = new URL(pageUrl).pathname || '/';
  } catch (e) {
    // keep default
  }

  return {
    path,
    metaTitle: metaTitle.trim(),
    metaDescription: metaDescription.trim(),
    metaText: [metaTitle, metaDescription].filter(Boolean).join(' | '),
    schemaText,
    bodyText,
    linkText,
    imageText,
    links,
  };
}

function bareHost(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

function pickSubpages(links, baseUrl, max) {
  const host = bareHost(baseUrl);
  const seen = new Set([new URL(baseUrl).pathname.replace(/\/$/, '') || '/']);
  const candidates = [];

  for (const link of links) {
    let u;
    try {
      u = new URL(link.href);
    } catch (e) {
      continue;
    }
    if (bareHost(u.href) !== host) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|docx?)$/i.test(u.pathname)) continue;

    const key = u.pathname.replace(/\/$/, '') || '/';
    if (seen.has(key)) continue;

    const haystack = `${u.pathname} ${link.text}`;
    let score = 0;
    for (const p of PAGE_PRIORITY) if (p.re.test(haystack)) score = Math.max(score, p.score);
    if (!score) continue;

    seen.add(key);
    u.hash = '';
    candidates.push({ url: u.href, score });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((c) => c.url);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
function stripFalsePositives(text) {
  let out = text;
  for (const re of FALSE_POSITIVE_PHRASES) out = out.replace(re, ' ');
  return out;
}

function snippetAround(text, index, length) {
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + length + 70);
  return `…${text.substring(start, end).trim()}…`;
}

function collectMatches(pages, termList, stripFP) {
  const found = new Map();

  for (const page of pages) {
    const sources = {
      text: page.bodyText,
      links: page.linkText,
      images: page.imageText,
      meta: page.metaText,
      schema: page.schemaText,
    };

    for (const [source, raw] of Object.entries(sources)) {
      if (!raw) continue;
      const text = stripFP ? stripFalsePositives(raw) : raw;

      for (const term of termList) {
        for (const pattern of term.patterns) {
          for (const m of text.matchAll(pattern)) {
            let entry = found.get(term.label);
            if (!entry) {
              entry = { label: term.label, count: 0, where: new Set(), snippet: null };
              found.set(term.label, entry);
            }
            entry.count++;
            entry.where.add(`${page.path} (${source})`);
            if (!entry.snippet) entry.snippet = snippetAround(text, m.index, m[0].length);
          }
        }
      }
    }
  }

  return [...found.values()]
    .map((e) => ({ ...e, where: [...e.where] }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Gemini: one call per site - summary + window-covering verdict
// ---------------------------------------------------------------------------
async function assessWithGemini(model, { domain, pages, windowCoverings, brands }) {
  const home = pages[0];
  const textExcerpt = pages
    .map((p) => `[${p.path}] ${p.bodyText.substring(0, 1200)}`)
    .join('\n')
    .substring(0, 3500);
  const linkLabels = [...new Set(pages.flatMap((p) => p.links.map((l) => l.text).filter(Boolean)))]
    .join(' | ')
    .substring(0, 800);
  const imageLabels = pages.map((p) => p.imageText).join(' | ').substring(0, 500);

  const prompt = `You are qualifying leads for a Hunter Douglas window treatment dealer. The company below is (probably) a home automation / smart home business. We need to know whether it sells, installs, or integrates WINDOW COVERINGS (motorized shades, blinds, drapery, shutters), not just lighting, AV, security, networking, or voice control.

Domain: ${domain}
Page title: ${home?.metaTitle || 'none'}
Meta description: ${home?.metaDescription || 'none'}
Structured data: ${home?.schemaText?.substring(0, 500) || 'none'}
Automation/motorization brands detected on site:
  - Shade motorization brands (strong evidence): ${brandsByTier(brands, 'shade').join(', ') || 'none'}
  - Whole-home control systems (moderate evidence): ${brandsByTier(brands, 'control').join(', ') || 'none'}
  - Generic platforms (weak evidence): ${brandsByTier(brands, 'platform').join(', ') || 'none'}
Window-covering terms detected on site: ${windowCoverings.map((w) => w.label).join(', ') || 'none'}
Navigation/link labels: ${linkLabels || 'none'}
Image alt text / filenames: ${imageLabels || 'none'}
Page text:
${textExcerpt || 'minimal/none'}

How to weigh brands: shade motorization brands (Somfy, PowerView, Rollease Acmeda, Bond) exist to motorize shades and blinds, so they are strong evidence. Whole-home control systems (Lutron, Crestron, Control4, Savant, etc.) can control shades, but many dealers only use them for lighting/AV, so look for shade context. Generic platforms (Alexa, Google, HomeKit, Bluetooth, Matter, Z-Wave, Zigbee) are weak evidence on their own.

Return JSON only, no markdown:
{"summary": "1-2 sentences on what the company primarily does", "worksWithWindowCoverings": "YES" | "NO" | "UNCLEAR", "reason": "one sentence citing the specific evidence"}

Answer YES only if there is reasonable evidence they supply, install, or integrate window coverings or shade motorization. Answer NO if they are clearly focused elsewhere with no shade evidence. Otherwise UNCLEAR.`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    const verdict = String(parsed.worksWithWindowCoverings || '').toUpperCase();
    return {
      summary: parsed.summary || null,
      verdict: ['YES', 'NO', 'UNCLEAR'].includes(verdict) ? verdict : 'UNCLEAR',
      reason: parsed.reason || null,
    };
  } catch (error) {
    console.error(`    ❌ Gemini error: ${error.message}`);
    return { summary: null, verdict: 'ERROR', reason: error.message.substring(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Per-site analysis
// ---------------------------------------------------------------------------
async function analyzeSite(inputUrl, { model, maxSubpages, skipOnGeminiNo }) {
  const pages = [];
  const fetchErrors = [];

  console.log('  → Fetching homepage...');
  const home = await fetchHtml(inputUrl);
  if (home.html) {
    pages.push({ type: 'homepage', url: home.finalUrl, ...extractPageSignals(home.html, home.finalUrl) });
  } else {
    fetchErrors.push(`homepage: ${home.error}`);
    console.warn(`  ⚠️  Homepage failed (${home.error})`);
  }

  let windowCoverings = collectMatches(pages, WINDOW_COVERING_TERMS, true);

  // Only crawl further if the homepage didn't already give an explicit mention
  if (!windowCoverings.length) {
    const baseUrl = home.finalUrl;
    let subUrls = pages.length ? pickSubpages(pages[0].links, baseUrl, maxSubpages) : [];
    if (!subUrls.length) {
      subUrls = FALLBACK_PATHS.slice(0, maxSubpages).map((p) => new URL(p, baseUrl).href);
    }

    for (const subUrl of subUrls) {
      console.log(`  → Fetching ${subUrl}`);
      const res = await fetchHtml(subUrl, 12000);
      if (!res.html) {
        fetchErrors.push(`${new URL(subUrl).pathname}: ${res.error}`);
        continue;
      }
      pages.push({ type: 'subpage', url: res.finalUrl, ...extractPageSignals(res.html, res.finalUrl) });
      windowCoverings = collectMatches(pages, WINDOW_COVERING_TERMS, true);
      if (windowCoverings.length) break; // explicit mention found, no need to keep crawling
    }
  } else {
    console.log('  ✓ Explicit window-covering mention on homepage');
  }

  if (!pages.length) {
    throw new Error(`Could not fetch any content (${fetchErrors.join('; ')})`);
  }

  const brands = collectMatches(pages, AUTOMATION_BRANDS, false);
  const brandTier = strongestBrandTier(brands);
  const totalBodyLength = pages.reduce((sum, p) => sum + p.bodyText.length, 0);
  const domain = bareHost(pages[0].url);

  const gemini = model ? await assessWithGemini(model, { domain, pages, windowCoverings, brands }) : null;
  const verdict = gemini?.verdict || 'NOT_RUN';

  let recommendation;
  let confidence;
  let decisionPath;
  let reasoning;

  if (windowCoverings.length) {
    recommendation = 'KEEP';
    confidence = 'high';
    decisionPath = 'explicit-window-covering';
    const top = windowCoverings[0];
    reasoning = `Explicit window-covering mention: "${top.label}" found on ${top.where.join(', ')}.`;
  } else if (brands.length) {
    const brandList = brands.map((b) => b.label).join(', ');
    if (verdict === 'YES') {
      recommendation = 'KEEP';
      confidence = 'medium';
      decisionPath = 'brand-gemini-confirmed';
      reasoning = `Automation brands found (${brandList}); Gemini confirmed window-covering work: ${gemini.reason}`;
    } else if (verdict === 'NO' && skipOnGeminiNo) {
      recommendation = 'SKIP';
      confidence = 'low';
      decisionPath = 'brand-gemini-rejected';
      reasoning = `Automation brands found (${brandList}) but Gemini found no window-covering work: ${gemini.reason}`;
    } else {
      recommendation = 'MAYBE';
      // Shade-specific brand = likely a real lead even if Gemini is unsure
      confidence = verdict === 'NO' ? 'low' : brandTier === 'shade' ? 'high' : brandTier === 'control' ? 'medium' : 'low';
      decisionPath = verdict === 'NO' ? 'brand-gemini-rejected' : 'brand-unconfirmed';
      reasoning =
        verdict === 'NO'
          ? `Automation brands found (${brandList}) but Gemini found no window-covering work: ${gemini.reason} Manual review recommended.`
          : `Automation brands found (${brandList}); window-covering work not confirmed (Gemini: ${verdict}). Manual review recommended.`;
    }
  } else if (verdict === 'YES') {
    recommendation = 'MAYBE';
    confidence = 'low';
    decisionPath = 'gemini-only';
    reasoning = `No on-page keyword or brand match, but Gemini thinks they work with window coverings: ${gemini.reason}`;
  } else {
    recommendation = 'SKIP';
    confidence = totalBodyLength < 300 ? 'low' : 'medium';
    decisionPath = 'no-signal';
    reasoning =
      totalBodyLength < 300
        ? 'No window-covering or automation brand signals, but very little text was extracted (site may be JS-rendered). Spot-check.'
        : 'No window-covering or automation brand signals found.';
  }

  return {
    recommendation,
    confidence,
    decisionPath,
    reasoning,
    windowCoveringTerms: windowCoverings.map((w) => w.label),
    windowCoveringEvidence: windowCoverings.slice(0, 3).map((w) => `${w.label} [${w.where[0]}]: ${w.snippet}`),
    automationBrandsFound: brands.map((b) => b.label),
    strongestBrandTier: brandTier || 'none',
    shadeBrandsFound: brandsByTier(brands, 'shade'),
    controlBrandsFound: brandsByTier(brands, 'control'),
    platformBrandsFound: brandsByTier(brands, 'platform'),
    automationBrandEvidence: brands.slice(0, 5).map((b) => `${b.label} [${b.where[0]}]: ${b.snippet}`),
    geminiVerdict: verdict,
    geminiReason: gemini?.reason || null,
    servicesSummary: gemini?.summary || null,
    pagesAnalyzed: pages.map((p) => p.url),
    lowTextWarning: totalBodyLength < 300,
    fetchErrors,
    detail: { windowCoverings, brands },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function normalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

Actor.main(async () => {
  const input = (await Actor.getInput()) || {};
  const { maxSubpages = 4, skipOnGeminiNo = false, delayMs = 1500 } = input;
  const geminiApiKey = input.geminiApiKey || process.env.GEMINI_API_KEY;
  const urls = [...new Set((input.urls || []).map(normalizeUrl).filter(Boolean))];

  // Log input without the API key
  console.log('Input:', JSON.stringify({ ...input, geminiApiKey: geminiApiKey ? '***' : undefined }, null, 2));

  if (!urls.length) throw new Error('No URLs provided. Input should contain a "urls" array.');

  const model = geminiApiKey
    ? new GoogleGenerativeAI(geminiApiKey).getGenerativeModel({
        model: GEMINI_MODEL,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      })
    : null;

  if (!model) {
    console.warn('⚠️  No Gemini API key: brand-only sites will stay MAYBE and no summaries will be generated.');
  }

  console.log('🧹 Clearing previous results...');
  await (await Actor.openDataset('results')).drop();
  await (await Actor.openDataset('detail-logs')).drop();
  const results = await Actor.openDataset('results');
  const detailLogs = await Actor.openDataset('detail-logs');

  const tally = { KEEP: 0, MAYBE: 0, SKIP: 0, ERROR: 0 };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);

    try {
      const analysis = await analyzeSite(url, { model, maxSubpages, skipOnGeminiNo });
      const { detail, ...summary } = analysis;

      await results.pushData({ url, status: 'success', ...summary, timestamp: new Date() });
      await detailLogs.pushData({
        url,
        recommendation: analysis.recommendation,
        decisionPath: analysis.decisionPath,
        windowCoverings: detail.windowCoverings,
        automationBrands: detail.brands,
        geminiVerdict: analysis.geminiVerdict,
        geminiReason: analysis.geminiReason,
        pagesAnalyzed: analysis.pagesAnalyzed,
        fetchErrors: analysis.fetchErrors,
        timestamp: new Date(),
      });

      tally[analysis.recommendation]++;
      console.log(`  ✅ ${analysis.recommendation} (${analysis.confidence}) via ${analysis.decisionPath}`);
    } catch (error) {
      tally.ERROR++;
      console.error(`  ❌ Error: ${error.message}`);
      await results.pushData({ url, status: 'error', error: error.message, timestamp: new Date() });
    }

    if (i < urls.length - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  console.log(`\n✅ Done. KEEP: ${tally.KEEP} | MAYBE: ${tally.MAYBE} | SKIP: ${tally.SKIP} | ERROR: ${tally.ERROR}`);
});
