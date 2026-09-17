import type { Express, Request, Response, NextFunction } from "express";
import type { PublicPageSeo } from "../shared/publicPageSeo";
import { OG_IMAGE, PUBLIC_PAGE_SEO_BY_SPECIALTY } from "../shared/publicPageSeo";
import { getMarketingNavLinks } from "../shared/seoCrawlerNav";
import { getStructuredData } from "../shared/seoStructuredData";
import {
  DEFAULT_SPECIALTY_ID,
  SPECIALTY_BOOTSTRAP_GLOBAL,
  getSpecialty,
  isKnownSpecialtyHost,
  normalizeHostname,
  specialtyFromHostname,
  type SpecialtyId,
} from "../shared/specialties";

/**
 * Public site origins are per specialty (see shared/specialties.ts): prs-atlas.com, ortho-atlas.com.
 * `CANONICAL_PUBLIC_ORIGIN` still forces a single origin for every host (useful for staging).
 */
export function normalizePublicOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase();
    const defaultPort = u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "";
    if (!u.port || u.port === defaultPort) return `${u.protocol}//${host}`;
    return `${u.protocol}//${host}:${u.port}`;
  } catch {
    return trimmed;
  }
}

function canonicalOriginOverride(): string {
  const fromEnv = process.env.CANONICAL_PUBLIC_ORIGIN?.trim();
  return fromEnv ? normalizePublicOrigin(fromEnv) : "";
}

/**
 * Canonical origin for a request host. Known specialty hosts always resolve to their own apex;
 * unknown hosts (Replit preview, localhost) fall back to the env override, then production default.
 */
export function getCanonicalOriginForHost(rawHost?: string | null): string {
  const host = normalizeHostname(rawHost);
  if (isKnownSpecialtyHost(host)) {
    return getSpecialty(specialtyFromHostname(host)).canonicalOrigin;
  }
  const override = canonicalOriginOverride();
  if (override) return override;
  if (process.env.NODE_ENV === "production") {
    return getSpecialty(DEFAULT_SPECIALTY_ID).canonicalOrigin;
  }
  return "";
}

/** Legacy single-origin accessor (no request host available). */
export function getCanonicalOrigin(): string {
  return getCanonicalOriginForHost(null);
}

/**
 * Apex `Domain` (".prs-atlas.com") for a known specialty host.
 * The session cookie is host-only; this is used to delete legacy domain-scoped cookies.
 */
export function sessionCookieDomainForHost(rawHost?: string | null): string | undefined {
  const host = normalizeHostname(rawHost);
  if (!isKnownSpecialtyHost(host)) return undefined;
  return `.${getSpecialty(specialtyFromHostname(host)).apexHost}`;
}

/** Specialty for a request host; unknown hosts use the env override's host, then the default. */
export function getSpecialtyForHost(rawHost?: string | null): SpecialtyId {
  const host = normalizeHostname(rawHost);
  if (isKnownSpecialtyHost(host)) return specialtyFromHostname(host);
  const override = canonicalOriginOverride();
  if (override) {
    try {
      return specialtyFromHostname(new URL(`${override}/`).hostname);
    } catch {
      return DEFAULT_SPECIALTY_ID;
    }
  }
  return DEFAULT_SPECIALTY_ID;
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** App/auth paths — noindex in HTML and Disallow in robots.txt (not in sitemap). */
export const NON_INDEXABLE_PATH_PREFIXES = [
  "/login",
  "/signup",
  "/reset-password",
  "/subscribe",
  "/bookmarks",
  "/spaced-repetition",
  "/oral-board",
  "/admin",
  "/api",
] as const;

function normalizePathname(urlPath: string): string {
  const p = urlPath.split("?")[0]?.split("#")[0] || "/";
  if (p === "/" || p === "") return "/";
  return p.endsWith("/") ? p.slice(0, -1) || "/" : p;
}

export function isMarketingIndexablePath(
  pathname: string,
  specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
): boolean {
  return metaForPath(pathname, specialtyId) !== undefined;
}

export function isNonIndexableAppPath(pathname: string): boolean {
  const p = normalizePathname(pathname);
  return NON_INDEXABLE_PATH_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(`${prefix}/`),
  );
}

function metaForPath(pathname: string, specialtyId: SpecialtyId): PublicPageSeo | undefined {
  return PUBLIC_PAGE_SEO_BY_SPECIALTY[specialtyId][normalizePathname(pathname)];
}

/** Strip :443 / :80 so redirect targets match canonical URLs (avoids GSC redirect validation issues). */
export function stripDefaultPortFromUrl(url: string): string {
  return url.replace(/:443(?=\/|$)/, "").replace(/:80(?=\/|$)/, "");
}

function buildRedirectUrl(pathWithQuery: string, origin: string): string {
  const base = normalizePublicOrigin(origin);
  const href = new URL(pathWithQuery || "/", `${base}/`).href;
  return stripDefaultPortFromUrl(href);
}

function redirect301(res: Response, target: string): void {
  res.redirect(301, stripDefaultPortFromUrl(target));
}

function injectAbsoluteFavicons(html: string, origin: string): string {
  const base = normalizePublicOrigin(origin);
  // Cache-bust so Google/browsers pick up the latest uploaded favicon.
  const v = "20260917a";
  const iconBlock = [
    `<link rel="icon" type="image/png" sizes="512x512" href="${base}/favicon.png?v=${v}" />`,
    `<link rel="icon" type="image/png" sizes="48x48" href="${base}/favicon-48.png?v=${v}" />`,
    `<link rel="icon" type="image/png" sizes="192x192" href="${base}/favicon-192.png?v=${v}" />`,
    `<link rel="shortcut icon" href="${base}/favicon-48.png?v=${v}" />`,
    `<link rel="icon" href="${base}/favicon.ico?v=${v}" sizes="48x48" />`,
    `<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png?v=${v}" />`,
    `<link rel="manifest" href="${base}/site.webmanifest?v=${v}" />`,
  ].join("\n    ");
  let out = html.replace(/<link\s+rel="icon"[^>]*>\s*/gi, "");
  out = out.replace(/<link\s+rel="apple-touch-icon"[^>]*>\s*/gi, "");
  out = out.replace(/<link\s+rel="manifest"[^>]*>\s*/gi, "");
  return out.replace("</head>", `    ${iconBlock}\n  </head>`);
}

function injectCrawlerSiteNav(html: string, origin: string, specialtyId: SpecialtyId): string {
  const base = normalizePublicOrigin(origin);
  const links = getMarketingNavLinks(specialtyId)
    .map(({ href, label }) => {
      const url = href === "/" ? `${base}/` : `${base}${href}`;
      return `<a href="${escapeAttr(url)}">${label}</a>`;
    })
    .join("\n      ");
  const footer = `<footer id="seo-crawler-nav" aria-label="Site pages">
    <nav>
      ${links}
    </nav>
  </footer>`;
  if (/<footer\s+id="seo-crawler-nav"/i.test(html)) {
    return html.replace(/<footer\s+id="seo-crawler-nav"[\s\S]*?<\/footer>/i, footer);
  }
  return html.replace("</body>", `  ${footer}\n  </body>`);
}

function setMetaName(html: string, name: string, content: string): string {
  const tag = `<meta name="${escapeAttr(name)}" content="${escapeAttr(content)}" />`;
  const re = new RegExp(`<meta\\s+name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`, "i");
  if (re.test(html)) return html.replace(re, tag);
  return html.replace("</head>", `    ${tag}\n  </head>`);
}

function setMetaProperty(html: string, property: string, content: string): string {
  const tag = `<meta property="${escapeAttr(property)}" content="${escapeAttr(content)}" />`;
  const re = new RegExp(
    `<meta\\s+property="${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
    "i",
  );
  if (re.test(html)) return html.replace(re, tag);
  return html.replace("</head>", `    ${tag}\n  </head>`);
}

function injectMarketingHeadTags(
  html: string,
  pathname: string,
  meta: PublicPageSeo,
  canonicalUrl: string,
  origin: string,
  specialtyId: SpecialtyId,
): string {
  const ogTitle = meta.ogTitle ?? meta.title;
  const ogDescription = meta.ogDescription ?? meta.description;
  const normOrigin = normalizePublicOrigin(origin);
  const ogImage = `${normOrigin}${OG_IMAGE.pathname}`;

  let out = setMetaName(html, "keywords", meta.keywords);
  out = setMetaProperty(out, "og:title", ogTitle);
  out = setMetaProperty(out, "og:description", ogDescription);
  out = setMetaProperty(out, "og:url", canonicalUrl);
  out = setMetaProperty(out, "og:type", "website");
  out = setMetaProperty(out, "og:image", ogImage);
  out = setMetaProperty(out, "og:image:width", String(OG_IMAGE.width));
  out = setMetaProperty(out, "og:image:height", String(OG_IMAGE.height));
  out = setMetaProperty(out, "og:image:type", OG_IMAGE.type);
  out = setMetaProperty(out, "og:image:alt", OG_IMAGE.alt);
  out = setMetaProperty(out, "og:site_name", getSpecialty(specialtyId).productName);
  out = setMetaProperty(out, "og:locale", "en_US");

  out = setMetaName(out, "twitter:card", "summary_large_image");
  out = setMetaName(out, "twitter:title", ogTitle);
  out = setMetaName(out, "twitter:description", ogDescription);
  out = setMetaName(out, "twitter:image", ogImage);
  out = setMetaName(out, "twitter:image:alt", OG_IMAGE.alt);

  const structured = getStructuredData(pathname, normOrigin, specialtyId);
  if (structured) {
    const raw = JSON.stringify(structured).replace(/</g, "\\u003c");
    const script = `<script type="application/ld+json" id="atlas-structured-data">${raw}</script>`;
    if (/<script[^>]*id="atlas-structured-data"/i.test(out)) {
      out = out.replace(/<script[^>]*id="atlas-structured-data"[^>]*>[\s\S]*?<\/script>/i, script);
    } else {
      out = out.replace("</head>", `    ${script}\n  </head>`);
    }
  }

  return out;
}

function injectRobotsMeta(html: string, content: string): string {
  const tag = `<meta name="robots" content="${escapeAttr(content)}" />`;
  if (/<meta\s+name="robots"/i.test(html)) {
    return html.replace(/<meta\s+name="robots"[^>]*>/i, tag);
  }
  return html.replace("</head>", `    ${tag}\n  </head>`);
}

/**
 * Sets `data-specialty` on <html> and a bootstrap global so the SPA themes the first paint
 * from the request host without waiting for an API round trip.
 */
function injectSpecialtyBootstrap(html: string, specialtyId: SpecialtyId): string {
  let out = html.replace(/<html([^>]*)\sdata-specialty="[^"]*"/i, "<html$1");
  out = out.replace(/<html\b([^>]*)>/i, `<html$1 data-specialty="${escapeAttr(specialtyId)}">`);
  const script = `<script id="atlas-specialty-bootstrap">window.${SPECIALTY_BOOTSTRAP_GLOBAL}=${JSON.stringify(
    { hostSpecialty: specialtyId },
  ).replace(/</g, "\\u003c")};</script>`;
  if (/<script[^>]*id="atlas-specialty-bootstrap"/i.test(out)) {
    return out.replace(/<script[^>]*id="atlas-specialty-bootstrap"[^>]*>[\s\S]*?<\/script>/i, script);
  }
  return out.replace("</head>", `    ${script}\n  </head>`);
}

/**
 * Injects per-route title, meta description, canonical, or noindex into the SPA index.html shell.
 * `host` selects the specialty (branding, SEO catalog, canonical origin).
 */
export function injectSpaIndexHtml(
  html: string,
  requestPathWithQuery: string,
  host?: string | null,
): string {
  const specialtyId = getSpecialtyForHost(host);
  const withBootstrap = injectSpecialtyBootstrap(html, specialtyId);

  const canonical = getCanonicalOriginForHost(host);
  if (!canonical) return withBootstrap;

  const pathname = normalizePathname(requestPathWithQuery);

  if (isNonIndexableAppPath(pathname)) {
    return injectRobotsMeta(withBootstrap, "noindex, nofollow");
  }

  const meta = metaForPath(pathname, specialtyId);
  if (!meta) {
    return injectRobotsMeta(withBootstrap, "noindex, nofollow");
  }

  const canonicalUrl = buildRedirectUrl(pathname === "/" ? "/" : pathname, canonical);
  const titleEscaped = meta.title.replace(/</g, "");
  const descEscaped = escapeAttr(meta.description);

  let out = withBootstrap.replace(/<title>[^<]*<\/title>/i, `<title>${titleEscaped}</title>`);
  out = out.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${descEscaped}" />`,
  );

  const canonicalTag = `<link rel="canonical" href="${escapeAttr(canonicalUrl)}" />`;
  if (/<link\s+rel="canonical"/i.test(out)) {
    out = out.replace(/<link\s+rel="canonical"[^>]*>/i, canonicalTag);
  } else {
    out = out.replace("</head>", `    ${canonicalTag}\n  </head>`);
  }

  out = injectMarketingHeadTags(out, pathname, meta, canonicalUrl, canonical, specialtyId);
  out = injectAbsoluteFavicons(out, canonical);
  out = injectCrawlerSiteNav(out, canonical, specialtyId);

  return injectRobotsMeta(out, "index, follow");
}

function sitemapPriority(path: string): string {
  if (path === "/") return "1.0";
  if (path === "/preview") return "0.85";
  if (path === "/terms" || path === "/privacy") return "0.5";
  return "0.8";
}

function sitemapChangeFreq(path: string): string {
  if (path === "/terms" || path === "/privacy") return "monthly";
  return "weekly";
}

function buildSitemapXml(base: string, specialtyId: SpecialtyId): string {
  const origin = normalizePublicOrigin(base);
  const lastMod = new Date().toISOString().slice(0, 10);
  const paths = getMarketingNavLinks(specialtyId).map((l) => l.href);
  const urls = paths
    .map(
      (p) =>
        `  <url>\n    <loc>${escapeAttr(`${origin}${p === "/" ? "/" : p}`)}</loc>\n    <lastmod>${lastMod}</lastmod>\n    <changefreq>${sitemapChangeFreq(p)}</changefreq>\n    <priority>${sitemapPriority(p)}</priority>\n  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function hostsFromHeader(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((part) => normalizeHostname(part))
    .filter(Boolean);
}

function hostnameFromUrlHeader(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return normalizeHostname(url.host);
  } catch {
    return "";
  }
}

/**
 * Which specialty site this request is for.
 *
 * Prefer `Host`, then browser `Origin` / `Referer`. `X-Forwarded-Host` is last
 * because Replit often sets it to the *primary* custom domain (prs-atlas.com)
 * even when the user is on ortho-atlas.com — that used to pin login to the PRS
 * q-bank and look like a redirect after signing in on Ortho.
 */
export function resolveRequestHostname(headers: {
  host?: unknown;
  "x-forwarded-host"?: unknown;
  origin?: unknown;
  referer?: unknown;
}): string {
  const fromHost = hostsFromHeader(headers.host);
  const fromOrigin = hostnameFromUrlHeader(headers.origin);
  const fromReferer = hostnameFromUrlHeader(headers.referer);
  const fromForwarded = hostsFromHeader(headers["x-forwarded-host"]);

  const knownFromHost = fromHost.find((h) => isKnownSpecialtyHost(h));
  if (knownFromHost) return knownFromHost;
  if (isKnownSpecialtyHost(fromOrigin)) return fromOrigin;
  if (isKnownSpecialtyHost(fromReferer)) return fromReferer;
  const knownFromForwarded = fromForwarded.find((h) => isKnownSpecialtyHost(h));
  if (knownFromForwarded) return knownFromForwarded;
  return fromHost[0] || fromOrigin || fromReferer || fromForwarded[0] || "";
}

export function requestHostname(req: Request): string {
  return resolveRequestHostname({
    host: req.headers.host,
    "x-forwarded-host": req.headers["x-forwarded-host"],
    origin: req.headers.origin,
    referer: req.headers.referer,
  });
}

/**
 * 301 www→apex and http→https for every configured specialty host.
 */
export function canonicalHostRedirect(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }

  const host = requestHostname(req);
  if (!host) {
    next();
    return;
  }

  const canonical = getCanonicalOriginForHost(host);
  if (!canonical) {
    next();
    return;
  }

  let canonicalHost: string;
  let needHttps: boolean;
  try {
    const parsed = new URL(`${canonical}/`);
    canonicalHost = parsed.hostname.toLowerCase();
    needHttps = parsed.protocol === "https:";
  } catch {
    next();
    return;
  }

  // Prefer the proxy header. A *missing* X-Forwarded-Proto means an internal probe
  // (Replit healthcheck hits the container directly) — do not treat that as plain HTTP
  // or we 301 to https:// and the checker reports failure (often as status 500).
  const forwardedProto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim().toLowerCase();
  const socketEncrypted = (req.socket as { encrypted?: boolean }).encrypted === true;

  const pathWithQuery = req.originalUrl || "/";

  if (host === `www.${canonicalHost}`) {
    redirect301(res, buildRedirectUrl(pathWithQuery, canonical));
    return;
  }

  if (needHttps && host === canonicalHost && forwardedProto === "http" && !socketEncrypted) {
    redirect301(res, buildRedirectUrl(pathWithQuery, canonical));
    return;
  }

  next();
}

/**
 * Registers GET /robots.txt, GET /sitemap.xml, and GET /site.webmanifest before static middleware.
 * All are host-aware so each domain advertises its own brand and canonical URLs.
 */
export function registerSeoPublicRoutes(app: Express): void {
  app.get("/robots.txt", (req, res) => {
    const host = requestHostname(req);
    const specialtyId = getSpecialtyForHost(host);
    const base =
      getCanonicalOriginForHost(host) || getSpecialty(DEFAULT_SPECIALTY_ID).canonicalOrigin;
    const disallow = NON_INDEXABLE_PATH_PREFIXES.map((p) => `Disallow: ${p}`).join("\n");
    // Ortho does not ship oral boards — keep crawlers off the PRS-only route if they guess the URL.
    const specialtyDisallow =
      specialtyId === "ortho" ? "Disallow: /oral-boards-coach\n" : "";
    const lines = [
      "User-agent: *",
      "Allow: /",
      "Allow: /favicon.ico",
      "Allow: /favicon-48.png",
      "Allow: /favicon-192.png",
      "Allow: /site.webmanifest",
      "",
      "User-agent: Googlebot-Image",
      "Allow: /favicon.ico",
      "Allow: /favicon-48.png",
      "Allow: /favicon-192.png",
      "",
      disallow,
      specialtyDisallow,
      `Sitemap: ${normalizePublicOrigin(base)}/sitemap.xml`,
      "",
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  app.get("/sitemap.xml", (req, res) => {
    const host = requestHostname(req);
    const specialtyId = getSpecialtyForHost(host);
    const base =
      getCanonicalOriginForHost(host) || getSpecialty(DEFAULT_SPECIALTY_ID).canonicalOrigin;
    res
      .status(200)
      .setHeader("Content-Type", "application/xml; charset=utf-8")
      .send(buildSitemapXml(base, specialtyId));
  });

  app.get("/site.webmanifest", (req, res) => {
    const host = requestHostname(req);
    const specialty = getSpecialty(getSpecialtyForHost(host));
    const origin =
      getCanonicalOriginForHost(host) || specialty.canonicalOrigin;
    const base = normalizePublicOrigin(origin);
    const v = "20260917a";
    const manifest = {
      name: specialty.brandName,
      short_name: specialty.brandName,
      description: `${specialty.specialtyName} board prep and Q&A study platform`,
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: specialty.id === "ortho" ? "#1F6B5C" : "#1E5AA8",
      icons: [
        {
          src: `${base}/favicon-48.png?v=${v}`,
          sizes: "48x48",
          type: "image/png",
          purpose: "any",
        },
        {
          src: `${base}/favicon-192.png?v=${v}`,
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: `${base}/atlas-app-icon.png?v=${v}`,
          sizes: "1024x1024",
          type: "image/png",
          purpose: "any",
        },
      ],
    };
    res
      .status(200)
      .setHeader("Content-Type", "application/manifest+json; charset=utf-8")
      .setHeader("Cache-Control", "public, max-age=3600")
      .send(JSON.stringify(manifest, null, 2));
  });
}
