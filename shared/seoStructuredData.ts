import { ORAL_BOARDS_MARKETING_FAQ, PRICING_MARKETING_FAQ } from "./marketingFaqs";
import type { PublicPageSeo } from "./publicPageSeo";
import { PUBLIC_PAGE_SEO_BY_SPECIALTY } from "./publicPageSeo";
import { DEFAULT_SPECIALTY_ID, getSpecialty, type SpecialtyId } from "./specialties";

function normalizePath(pathname: string): string {
  const p = pathname.split("?")[0]?.split("#")[0] || "/";
  if (p === "" || p === "/") return "/";
  return p.endsWith("/") ? p.slice(0, -1) || "/" : p;
}

function pageUrl(pathname: string, origin: string): string {
  if (pathname === "/") return `${origin}/`;
  return `${origin}${pathname}`;
}

function organizationAndWebSite(
  meta: PublicPageSeo,
  origin: string,
  specialtyId: SpecialtyId,
): Record<string, unknown>[] {
  const specialty = getSpecialty(specialtyId);
  return [
    {
      "@type": "Organization",
      "@id": `${origin}/#organization`,
      name: specialty.legalEntity,
      url: origin,
      logo: {
        "@type": "ImageObject",
        url: `${origin}/favicon-192.png?v=20260917a`,
        width: 192,
        height: 192,
      },
    },
    {
      "@type": "WebSite",
      "@id": `${origin}/#website`,
      url: origin,
      name: specialty.productName,
      alternateName: `${specialty.specialtyName} Atlas Review`,
      description: meta.description,
      publisher: { "@id": `${origin}/#organization` },
      inLanguage: "en-US",
    },
  ];
}

function webPageJson(pathname: string, meta: PublicPageSeo, origin: string): Record<string, unknown> {
  const url = pageUrl(pathname, origin);
  return {
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: meta.title,
    description: meta.description,
    isPartOf: { "@id": `${origin}/#website` },
    inLanguage: "en-US",
  };
}

function faqJsonLd(
  pathname: string,
  origin: string,
  specialtyId: SpecialtyId,
): Record<string, unknown> | null {
  const faqs =
    pathname === "/pricing"
      ? PRICING_MARKETING_FAQ
      : pathname === "/oral-boards-coach" && specialtyId === "prs"
        ? ORAL_BOARDS_MARKETING_FAQ
        : null;
  if (!faqs) return null;
  const url = pageUrl(pathname, origin);
  return {
    "@type": "FAQPage",
    "@id": `${url}#faq`,
    mainEntity: faqs.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };
}

/**
 * JSON-LD for marketing routes. Used by server HTML injection and client usePageSeo.
 */
export function getStructuredData(
  pathname: string,
  origin?: string,
  specialtyId: SpecialtyId = DEFAULT_SPECIALTY_ID,
): Record<string, unknown> | null {
  const specialty = getSpecialty(specialtyId);
  const resolvedOrigin = origin ?? specialty.canonicalOrigin;
  const catalog = PUBLIC_PAGE_SEO_BY_SPECIALTY[specialty.id];
  const n = normalizePath(pathname);
  const meta = catalog[n];
  if (!meta) return null;

  if (n === "/") {
    return {
      "@context": "https://schema.org",
      "@graph": organizationAndWebSite(meta, resolvedOrigin, specialty.id),
    };
  }

  const graph: Record<string, unknown>[] = [
    ...organizationAndWebSite(catalog["/"]!, resolvedOrigin, specialty.id),
    webPageJson(n, meta, resolvedOrigin),
  ];

  const faq = faqJsonLd(n, resolvedOrigin, specialty.id);
  if (faq) graph.push(faq);

  return {
    "@context": "https://schema.org",
    "@graph": graph,
  };
}
