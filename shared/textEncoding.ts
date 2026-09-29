/**
 * Repair "MacRoman mojibake": UTF-8 text that was decoded as Mac OS Roman somewhere upstream
 * (typically a spreadsheet/CSV round trip on a Mac), e.g.
 *   "0‚Äì4 weeks"  -> "0–4 weeks"   (en dash, bytes E2 80 93)
 *   "5 √ó 8 mm"   -> "5 × 8 mm"    (multiplication sign, bytes C3 97)
 *   "patient‚Äôs"  -> "patient’s"   (right single quote, bytes E2 80 99)
 *
 * In the production question bank a later step also stripped accents, so the trailing byte of
 * some sequences lost its diacritic ("‚Äì" became "‚Äi", "√ó" became "√o", "‚Äô" became "‚Äo").
 * Those cases are ambiguous and are resolved by context (see repairStrippedSequences).
 *
 * Pure functions, no dependencies, so scripts, the import path and tests can share them.
 */

/** Mac OS Roman 0x80-0xFF as Unicode. */
const MAC_ROMAN_HIGH =
  "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uf8ffÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";

const UNICODE_TO_MAC = new Map<string, number>();
for (let i = 0; i < MAC_ROMAN_HIGH.length; i++) UNICODE_TO_MAC.set(MAC_ROMAN_HIGH[i], 0x80 + i);

/** Characters that begin a UTF-8 multi-byte sequence when read as MacRoman: C2/C3 -> ¬/√, E2 -> ‚. */
const LEAD_TWO = new Set(["\u00ac", "\u221a"]); // ¬ (C2), √ (C3)
const LEAD_THREE = new Set(["\u201a"]); // ‚ (E2)

function macBytes(chars: string): number[] | null {
  const out: number[] = [];
  for (const ch of chars) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else {
      const b = UNICODE_TO_MAC.get(ch);
      if (b === undefined) return null;
      out.push(b);
    }
  }
  return out;
}

function decodeUtf8Strict(bytes: number[]): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

const OPENERS = /[\s([{\u2014\u2013"'\u201c\u2018\/]$/;

/**
 * Double mojibake seen in production: a character was first read as Windows-1252 ("â€™"), then that
 * text was read as MacRoman, and the leading "√¢" and the accent on the last byte were lost.
 *   "‚Ç¨‚Ñ¢" -> ’    "‚Ç¨‚Äú" / "‚Ç¨‚Äù" (accent stripped: "‚Ç¨‚Äu") -> –
 */
function repairDoubleMojibake(text: string): string {
  return text
    .replace(/(?:\u221a\u00a2)?\u201a\u00c7\u00a8\u201a\u00d1\u00a2/g, "\u2019")
    .replace(/(?:\u221a\u00a2)?\u201a\u00c7\u00a8\u201a\u00c4[uiúùìî]/g, "\u2013");
}

/** Stripped-accent fallbacks ("‚Äi" etc.), resolved with the characters around them. */
function repairStrippedSequences(text: string): string {
  let out = text;
  // × (C3 97): "√ó" -> "√o" once the accent is stripped. Only between dimension-like tokens.
  out = out.replace(/(\d[\d.,]*(?:\s*-?\s*[a-zA-Z%]{0,3})?)(\s*)\u221ao(\s*)(?=\d)/g, "$1$2\u00d7$3");
  // en/em dash (E2 80 93 / E2 80 94): "‚Äì"/"‚Äî" -> "‚Äi"
  {
    const token = "\u201a\u00c4i";
    let result = "";
    let pos = 0;
    for (let idx = out.indexOf(token, pos); idx !== -1; idx = out.indexOf(token, pos)) {
      result += out.slice(pos, idx);
      const b = result.slice(-1);
      const a = out.charAt(idx + token.length);
      let dash = "\u2014";
      if (/\d/.test(b) && /\d/.test(a)) dash = "\u2013"; // ranges: 5–8
      else if (/\s/.test(b) || /\s/.test(a) || a === "") dash = "\u2013"; // spaced: "Part I – Basic"
      else if (/[A-Za-z]+-[A-Za-z]+$/.test(result)) dash = "\u2013"; // hyphenated compound: right-hand–dominant
      result += dash;
      pos = idx + token.length;
    }
    out = result + out.slice(pos);
  }
  // apostrophe / single quotes (E2 80 98 / 99): -> "‚Äo"
  out = out.replace(/(^|[\s\S])\u201a\u00c4o(?=([\s\S]?))/g, (_m, before: string, next: string) => {
    const opening = before !== "" && /[\s([{]/.test(before) && /[A-Za-z0-9]/.test(next);
    return `${before}${opening ? "\u2018" : "\u2019"}`;
  });
  // double quotes (E2 80 9C / 9D): -> "‚Äu"; choose open/close by what precedes it.
  out = out.replace(/(^|[\s\S])\u201a\u00c4u/g, (_m, before: string) => {
    const opening = before === "" || OPENERS.test(before);
    return `${before}${opening ? "\u201c" : "\u201d"}`;
  });
  return out;
}

/** Returns the repaired text (unchanged when there is nothing to repair). */
export function repairMojibake(text: string): string {
  if (!text) return text;
  text = repairDoubleMojibake(text);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const need = LEAD_TWO.has(ch) ? 2 : LEAD_THREE.has(ch) ? 3 : 0;
    if (need) {
      const chunk = Array.from(text.slice(i, i + need + 2)).slice(0, need).join("");
      const bytes = macBytes(chunk);
      const decoded = bytes && bytes.length === need ? decodeUtf8Strict(bytes) : null;
      if (decoded) {
        out += decoded;
        i += chunk.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return repairStrippedSequences(out);
}

/** True when the text still contains the telltale MacRoman lead characters followed by a non-space. */
export function looksLikeMojibake(text: string): boolean {
  return /[\u201a\u221a\u00ac][^\s]/.test(text ?? "");
}
