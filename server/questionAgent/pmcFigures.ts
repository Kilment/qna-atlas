/**
 * PubMed Central open-access figure sourcing.
 *
 * Search:    Europe PMC REST API (full-text search, license and open-access filters).
 * Content:   PMC Open Access dataset on AWS (s3://pmc-oa-opendata, public HTTPS). Each article
 *            folder has <PMCID>.<ver>.json (authoritative license_code), the JATS XML (figure
 *            captions) and the figure image files.
 *
 * Only commercial-friendly licenses pass (CC0, CC BY, CC BY-SA); NC and ND are rejected, as are
 * figures that look like third-party material reproduced inside an open article.
 */
import { assessImageLicense } from "../../shared/imageLicense";

export const EUROPE_PMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
export const PMC_OA_BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com";

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface PmcArticleHit {
  pmcid: string;
  title: string;
  authorString: string;
  journal: string;
  year: string;
  doi: string | null;
  license: string | null;
}

export interface PmcFigure {
  figId: string;
  label: string;
  caption: string;
  /** Image file names from the JATS graphic elements, preferred (full size) first. */
  hrefs: string[];
  /** Figure has its own <permissions>/<attrib> (likely third-party material). */
  ownPermissions: boolean;
}

export interface PmcArticleMeta {
  pmcid: string;
  versionPrefix: string; // e.g. PMC123.1
  licenseCode: string | null;
  retracted: boolean;
  mediaUrls: string[];
}

/** Markers of third-party or restricted material inside an otherwise open article. */
const THIRD_PARTY_MARKERS = [
  /reproduced (?:with|from|by)/i,
  /reprinted (?:with|from|by)/i,
  /adapted (?:with|from)/i,
  /modified from/i,
  /taken from/i,
  /used with permission/i,
  /with (?:kind )?permission/i,
  /courtesy of/i,
  /©|\(c\)\s*\d{4}|copyright/i,
  /all rights reserved/i,
  /image source:/i,
  /source:\s*(?:www\.|https?:)/i,
];

export function thirdPartyRisk(caption: string): string | null {
  for (const re of THIRD_PARTY_MARKERS) {
    const m = re.exec(caption);
    if (m) return `caption suggests third-party material ("${m[0]}")`;
  }
  return null;
}

/** True when the caption text reveals any of the given answer terms (case-insensitive). */
export function captionLeaksAnswer(caption: string, avoidTerms: string[]): string | null {
  const lower = caption.toLowerCase();
  for (const t of avoidTerms) {
    const term = t.trim().toLowerCase();
    if (term.length >= 3 && lower.includes(term)) return `caption mentions "${t.trim()}"`;
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

export function stripXml(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<\?[\s\S]*?\?>/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract figures (flat <fig> elements) from JATS XML. */
export function parseFigures(xml: string): PmcFigure[] {
  const out: PmcFigure[] = [];
  const figRe = /<fig(?:\s[^>]*)?>([\s\S]*?)<\/fig>/g;
  const openTagRe = /<fig(\s[^>]*)?>/g;
  const openTags = [...xml.matchAll(openTagRe)];
  let idx = 0;
  for (const m of xml.matchAll(figRe)) {
    const attrs = openTags[idx++]?.[1] ?? "";
    const body = m[1];
    const figId = /\bid="([^"]+)"/.exec(attrs)?.[1] ?? `fig-${idx}`;
    const label = stripXml(/<label[^>]*>([\s\S]*?)<\/label>/.exec(body)?.[1] ?? "");
    const caption = stripXml(/<caption[^>]*>([\s\S]*?)<\/caption>/.exec(body)?.[1] ?? "");
    const graphics = [...body.matchAll(/<graphic\b([^>]*)>/g)].map((g) => ({
      href: /xlink:href="([^"]+)"/.exec(g[1])?.[1] ?? "",
      type: /content-type="([^"]+)"/.exec(g[1])?.[1] ?? "",
    }));
    // Prefer the full-size graphic; drop thumbnails.
    const sorted = [...graphics].sort((a, b) => Number(a.type === "thumb") - Number(b.type === "thumb"));
    const hrefs = sorted.filter((g) => g.href && g.type !== "thumb").map((g) => g.href);
    const hasOwnPermissions = /<permissions\b|<attrib\b/.test(body);
    out.push({
      figId,
      label,
      caption,
      hrefs,
      ownPermissions: hasOwnPermissions,
    });
  }
  return out;
}

/** Match a JATS href (often without extension) to a real file in the article folder. */
export function pickMediaUrl(href: string, mediaUrls: string[]): string | null {
  const clean = (u: string) => u.split("?")[0];
  const base = href.split("/").pop() ?? href;
  const exact = mediaUrls.find((u) => clean(u).endsWith(`/${base}`));
  if (exact) return clean(exact);
  const stem = base.replace(/\.[a-z0-9]+$/i, "");
  const byStem = mediaUrls.find((u) => {
    const file = clean(u).split("/").pop() ?? "";
    return file.replace(/\.[a-z0-9]+$/i, "") === stem && /\.(jpe?g|png|webp|gif)$/i.test(file);
  });
  return byStem ? clean(byStem) : null;
}

export function s3HttpsUrl(s3OrHttps: string): string {
  const m = /^s3:\/\/pmc-oa-opendata\/(.+)$/.exec(s3OrHttps);
  return m ? `${PMC_OA_BUCKET}/${m[1]}` : s3OrHttps;
}

function esc(s: string): string {
  return encodeURIComponent(s);
}

export function buildSearchQuery(terms: string, extra = ""): string {
  const filters =
    'OPEN_ACCESS:y AND HAS_FT:y AND (LICENSE:"cc by" OR LICENSE:"cc0" OR LICENSE:"cc by-sa")';
  return `(${terms}) AND ${filters}${extra ? ` AND (${extra})` : ""}`;
}

export async function searchArticles(
  fetchFn: FetchLike,
  terms: string,
  options: { extra?: string; pageSize?: number } = {}
): Promise<PmcArticleHit[]> {
  const url = `${EUROPE_PMC_SEARCH}?query=${esc(buildSearchQuery(terms, options.extra))}&resultType=core&format=json&pageSize=${
    options.pageSize ?? 15
  }`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Europe PMC search failed: HTTP ${res.status}`);
  const json = JSON.parse(await res.text());
  const results: any[] = json?.resultList?.result ?? [];
  return results
    .filter((r) => typeof r.pmcid === "string")
    .map((r) => ({
      pmcid: r.pmcid,
      title: stripXml(String(r.title ?? "")),
      authorString: String(r.authorString ?? ""),
      journal: String(r.journalInfo?.journal?.title ?? r.journalTitle ?? ""),
      year: String(r.pubYear ?? ""),
      doi: r.doi ?? null,
      license: r.license ?? null,
    }));
}

/** Find the article folder (PMC123.<version>) and its authoritative metadata JSON. */
export async function fetchArticleMeta(fetchFn: FetchLike, pmcid: string): Promise<PmcArticleMeta | null> {
  const listUrl = `${PMC_OA_BUCKET}/?list-type=2&prefix=${esc(`${pmcid}.`)}&delimiter=%2F&max-keys=50`;
  const listRes = await fetchFn(listUrl);
  if (!listRes.ok) return null;
  const listing = await listRes.text();
  const prefixes = [...listing.matchAll(/<Prefix>(PMC\d+\.\d+)\/<\/Prefix>/g)].map((m) => m[1]);
  if (prefixes.length === 0) return null;
  const latest = prefixes.sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1])).pop()!;
  const jsonRes = await fetchFn(`${PMC_OA_BUCKET}/${latest}/${latest}.json`);
  if (!jsonRes.ok) return null;
  const meta = JSON.parse(await jsonRes.text());
  return {
    pmcid,
    versionPrefix: latest,
    licenseCode: typeof meta.license_code === "string" ? meta.license_code : null,
    retracted: meta.is_retracted === true,
    mediaUrls: Array.isArray(meta.media_urls) ? meta.media_urls.map((u: string) => s3HttpsUrl(u)) : [],
  };
}

export function buildCredit(hit: Pick<PmcArticleHit, "authorString" | "title" | "journal" | "year">, figLabel: string): string {
  const firstAuthor = hit.authorString.split(",")[0]?.trim().replace(/\.$/, "");
  const who = firstAuthor ? `${firstAuthor} et al.` : "Authors";
  const title = hit.title.replace(/\.$/, "");
  const text = `${who} ${title}. ${hit.journal} ${hit.year}${figLabel ? ` (${figLabel})` : ""}`.replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

export interface FigureCandidate {
  pmcid: string;
  figId: string;
  label: string;
  caption: string;
  imageUrl: string;
  license: string; // canonical
  credit: string;
  sourceUrl: string;
  articleTitle: string;
}

export interface RejectedFigure {
  pmcid: string;
  figId: string;
  reason: string;
}

/** Turn one article into vetted figure candidates (no image download here). */
export function vetArticleFigures(params: {
  hit: PmcArticleHit;
  meta: PmcArticleMeta;
  figures: PmcFigure[];
  avoidTerms: string[];
}): { accepted: FigureCandidate[]; rejected: RejectedFigure[] } {
  const { hit, meta, figures, avoidTerms } = params;
  const accepted: FigureCandidate[] = [];
  const rejected: RejectedFigure[] = [];
  const reject = (figId: string, reason: string) => rejected.push({ pmcid: hit.pmcid, figId, reason });

  const verdict = assessImageLicense(meta.licenseCode);
  if (!verdict.allowed || !verdict.canonical) {
    reject("*", `license not allowed: ${verdict.reason ?? meta.licenseCode ?? "unknown"}`);
    return { accepted, rejected };
  }
  if (meta.retracted) {
    reject("*", "article is retracted");
    return { accepted, rejected };
  }
  for (const fig of figures) {
    const risk = fig.ownPermissions
      ? "figure carries its own permissions or attribution (likely third-party material)"
      : thirdPartyRisk(fig.caption);
    if (risk) {
      reject(fig.figId, risk);
      continue;
    }
    const leak = captionLeaksAnswer(fig.caption, avoidTerms);
    if (leak) {
      reject(fig.figId, leak);
      continue;
    }
    let imageUrl: string | null = null;
    for (const href of fig.hrefs) {
      imageUrl = pickMediaUrl(href, meta.mediaUrls);
      if (imageUrl) break;
    }
    if (!imageUrl) {
      reject(fig.figId, "no downloadable image file for this figure");
      continue;
    }
    accepted.push({
      pmcid: hit.pmcid,
      figId: fig.figId,
      label: fig.label,
      caption: fig.caption,
      imageUrl,
      license: verdict.canonical,
      credit: buildCredit(hit, fig.label),
      sourceUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${hit.pmcid}/`,
      articleTitle: hit.title,
    });
  }
  return { accepted, rejected };
}
