/**
 * License policy for agent-sourced images: commercial use with attribution is fine
 * (CC0, CC BY, CC BY-SA, public domain). NonCommercial (NC) and NoDerivatives (ND) are rejected
 * because this is a paid product and images may be re-encoded for display.
 */
export interface LicenseVerdict {
  allowed: boolean;
  /** Normalized label such as "CC BY 4.0" (null when unrecognized). */
  canonical: string | null;
  reason?: string;
}

function version(text: string): string {
  const m = text.match(/\b([1-4]\.\d)\b/);
  return m ? ` ${m[1]}` : "";
}

export function assessImageLicense(raw: string | null | undefined): LicenseVerdict {
  const input = (raw ?? "").trim();
  if (!input) return { allowed: false, canonical: null, reason: "no license stated" };

  // Creative Commons URL form: creativecommons.org/licenses/by-nc/4.0/ or /publicdomain/zero/1.0/
  const url = input.match(/creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/?([0-9.]+)?/i);
  let text = input.toLowerCase();
  if (url) {
    const kind = url[2].toLowerCase();
    if (url[1].toLowerCase() === "publicdomain" || kind === "zero") text = "cc0";
    else text = `cc ${kind}${url[3] ? ` ${url[3]}` : ""}`;
  }
  text = text.replace(/[_\s]+/g, " ").replace(/\s*-\s*/g, "-").replace(/^creative commons /, "cc ");

  if (/(^|[ -])nc([ -]|$)|noncommercial|non-commercial/.test(text)) {
    return { allowed: false, canonical: null, reason: "NonCommercial license" };
  }
  if (/(^|[ -])nd([ -]|$)|noderiv|no derivat/.test(text)) {
    return { allowed: false, canonical: null, reason: "NoDerivatives license" };
  }
  if (/^cc0\b|^cc zero|^cc-zero/.test(text)) return { allowed: true, canonical: "CC0" };
  if (/^public domain|^pd\b/.test(text)) return { allowed: true, canonical: "Public Domain" };
  if (/^cc[ -]by-sa\b/.test(text)) return { allowed: true, canonical: `CC BY-SA${version(text)}` };
  if (/^cc[ -]by\b/.test(text)) return { allowed: true, canonical: `CC BY${version(text)}` };
  return { allowed: false, canonical: null, reason: `unrecognized or restricted license "${input}"` };
}
