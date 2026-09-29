/**
 * Shared parsing helpers for Excel → DB import and (optionally) client parseQuestions.
 * Node-safe: no DOM (document.createElement). Keeps output identical to current parseQuestions.
 */

import { repairMojibake } from "./textEncoding";

const entityMap: Record<string, string> = {
  '&rsquo;': "'",
  '&lsquo;': "'",
  '&apos;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&#34;': '"',
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&ndash;': '–',
  '&mdash;': '—',
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
};

/** Node-safe decode. Same entityMap + unicode normalizations as parseQuestions. Replaces textarea fallback with &#decimal; / &#xhex; handling. */
export function decodeHtmlEntities(text: string): string {
  // Restore Mac text-encoding damage (e.g. "‚Äì" for an en dash) BEFORE the accent stripping below
  // destroys the evidence and leaves unrecoverable fragments such as "‚Äi".
  let result = repairMojibake(text);
  for (const [entity, char] of Object.entries(entityMap)) {
    result = result.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), char);
  }
  result = result
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : `&#${d};`;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const n = parseInt(h, 16);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : `&#x${h};`;
    });
  return result
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00F4]/g, 'o')
    .replace(/[\u00D6]/g, 'O')
    .replace(/[\u00F6]/g, 'o')
    .replace(/[\u00DC]/g, 'U')
    .replace(/[\u00FC]/g, 'u')
    .replace(/[\u00E9]/g, 'e')
    .replace(/[\u00E8]/g, 'e')
    .replace(/[\u00EA]/g, 'e')
    .replace(/[\u00EB]/g, 'e')
    .replace(/[\u00E0]/g, 'a')
    .replace(/[\u00E2]/g, 'a')
    .replace(/[\u00E7]/g, 'c')
    .replace(/[\u00ED]/g, 'i')
    .replace(/[\u00EC]/g, 'i')
    .replace(/[\u00EE]/g, 'i')
    .replace(/[\u00EF]/g, 'i')
    .replace(/[\u00F1]/g, 'n')
    .replace(/[\u00F2]/g, 'o')
    .replace(/[\u00F3]/g, 'o')
    .replace(/[\u00F5]/g, 'o')
    .replace(/[\u00FA]/g, 'u')
    .replace(/[\u00F9]/g, 'u')
    .replace(/[\u00FB]/g, 'u');
}

export function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<div>/g, '\n')
      .replace(/<\/div>/g, '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<span[^>]*>/g, '')
      .replace(/<\/span>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\\/g, '')
      .trim()
  );
}

export const categoryMapping: Record<string, { section: string; subsection: string }> = {
  'wound': { section: 'comprehensive', subsection: 'anatomy' },
  'skin': { section: 'comprehensive', subsection: 'skin-lesions' },
  'flap': { section: 'comprehensive', subsection: 'flaps-and-grafts' },
  'graft': { section: 'comprehensive', subsection: 'flaps-and-grafts' },
  'microsurgery': { section: 'comprehensive', subsection: 'microsurgery' },
  'infection': { section: 'comprehensive', subsection: 'infections' },
  'burn': { section: 'comprehensive', subsection: 'burns' },
  'trunk': { section: 'comprehensive', subsection: 'trunk' },
  'chest wall': { section: 'comprehensive', subsection: 'trunk' },
  'gender': { section: 'comprehensive', subsection: 'gender-affirming-surgery' },
  'vascular anomal': { section: 'comprehensive', subsection: 'vascular-anomalies' },
  'hemangioma': { section: 'comprehensive', subsection: 'vascular-anomalies' },
  'hand trauma': { section: 'hand-lower-extremity', subsection: 'hand-digit-trauma' },
  'digit': { section: 'hand-lower-extremity', subsection: 'hand-digit-trauma' },
  'fracture': { section: 'hand-lower-extremity', subsection: 'hand-digit-trauma' },
  'nerve': { section: 'hand-lower-extremity', subsection: 'hand-nerves' },
  'tendon': { section: 'hand-lower-extremity', subsection: 'hand-tendons' },
  'replant': { section: 'hand-lower-extremity', subsection: 'replantation-vascular' },
  'vascular': { section: 'hand-lower-extremity', subsection: 'replantation-vascular' },
  'wrist': { section: 'hand-lower-extremity', subsection: 'wrist-forearm-injuries' },
  'forearm': { section: 'hand-lower-extremity', subsection: 'wrist-forearm-injuries' },
  'hand tumor': { section: 'hand-lower-extremity', subsection: 'hand-tumors' },
  'dupuytren': { section: 'hand-lower-extremity', subsection: 'hand-inflammation-infections' },
  'arthritis': { section: 'hand-lower-extremity', subsection: 'hand-inflammation-infections' },
  'congenital hand': { section: 'hand-lower-extremity', subsection: 'congenital-pediatric-hand' },
  'pediatric hand': { section: 'hand-lower-extremity', subsection: 'congenital-pediatric-hand' },
  'lower extremity': { section: 'hand-lower-extremity', subsection: 'lower-extremity' },
  'leg': { section: 'hand-lower-extremity', subsection: 'lower-extremity' },
  'foot': { section: 'hand-lower-extremity', subsection: 'lower-extremity' },
  'cleft': { section: 'craniomaxillofacial', subsection: 'cleft-lip-palate' },
  'facial fracture': { section: 'craniomaxillofacial', subsection: 'facial-fractures' },
  'midface': { section: 'craniomaxillofacial', subsection: 'facial-fractures' },
  'orbital': { section: 'craniomaxillofacial', subsection: 'facial-fractures' },
  'facial paralysis': { section: 'craniomaxillofacial', subsection: 'facial-paralysis' },
  'facial nerve': { section: 'craniomaxillofacial', subsection: 'facial-paralysis' },
  'ear': { section: 'craniomaxillofacial', subsection: 'ear-reconstruction' },
  'microtia': { section: 'craniomaxillofacial', subsection: 'ear-reconstruction' },
  'mandible': { section: 'craniomaxillofacial', subsection: 'mandible-dental-orthognathic' },
  'dental': { section: 'craniomaxillofacial', subsection: 'mandible-dental-orthognathic' },
  'orthognathic': { section: 'craniomaxillofacial', subsection: 'mandible-dental-orthognathic' },
  'head and neck': { section: 'craniomaxillofacial', subsection: 'head-neck-tumors' },
  'oral': { section: 'craniomaxillofacial', subsection: 'head-neck-tumors' },
  'cancer': { section: 'craniomaxillofacial', subsection: 'head-neck-tumors' },
  'craniosynostosis': { section: 'craniomaxillofacial', subsection: 'congenital-syndromes' },
  'craniofacial': { section: 'craniomaxillofacial', subsection: 'congenital-syndromes' },
  'syndrome': { section: 'craniomaxillofacial', subsection: 'congenital-syndromes' },
  'breast augmentation': { section: 'breast-cosmetic', subsection: 'breast-augmentation' },
  'breast implant': { section: 'breast-cosmetic', subsection: 'breast-augmentation' },
  'breast reduction': { section: 'breast-cosmetic', subsection: 'breast-reduction-mastopexy' },
  'mastopexy': { section: 'breast-cosmetic', subsection: 'breast-reduction-mastopexy' },
  'breast reconstruction': { section: 'breast-cosmetic', subsection: 'breast-reconstruction' },
  'mastectomy': { section: 'breast-cosmetic', subsection: 'breast-reconstruction' },
  'face': { section: 'breast-cosmetic', subsection: 'facial-rejuvenation' },
  'facelift': { section: 'breast-cosmetic', subsection: 'facial-rejuvenation' },
  'blepharoplasty': { section: 'breast-cosmetic', subsection: 'eye-aesthetic-reconstructive' },
  'rhinoplasty': { section: 'breast-cosmetic', subsection: 'rhinoplasty' },
  'nose': { section: 'breast-cosmetic', subsection: 'rhinoplasty' },
  'body contouring': { section: 'breast-cosmetic', subsection: 'body-contouring' },
  'liposuction': { section: 'breast-cosmetic', subsection: 'body-contouring' },
  'abdominoplasty': { section: 'breast-cosmetic', subsection: 'body-contouring' },
  'anesthesia': { section: 'core-surgical', subsection: 'anesthesia' },
  'anesthetic': { section: 'core-surgical', subsection: 'anesthesia' },
  'perioperative': { section: 'core-surgical', subsection: 'perioperative-care' },
  'postoperative': { section: 'core-surgical', subsection: 'perioperative-care' },
  'critical care': { section: 'core-surgical', subsection: 'critical-care' },
  'trauma': { section: 'core-surgical', subsection: 'trauma' },
  'transplant': { section: 'core-surgical', subsection: 'transplantation' },
  'statistic': { section: 'core-surgical', subsection: 'statistics-ethics-practice' },
  'ethics': { section: 'core-surgical', subsection: 'statistics-ethics-practice' },
  'practice management': { section: 'core-surgical', subsection: 'statistics-ethics-practice' },
};

export function categorizeQuestion(category: string, subcategory: string): { section: string; subsection: string } {
  const combined = `${category} ${subcategory}`.toLowerCase();
  for (const [key, value] of Object.entries(categoryMapping)) {
    if (combined.includes(key)) return value;
  }
  return { section: 'comprehensive', subsection: 'anatomy' };
}

export const sectionOrder: { id: string; title: string; sortOrder: number }[] = [
  { id: 'comprehensive', title: 'Section 1: Comprehensive', sortOrder: 0 },
  { id: 'hand-lower-extremity', title: 'Section 2: Hand & Lower Extremity', sortOrder: 1 },
  { id: 'craniomaxillofacial', title: 'Section 3: Craniomaxillofacial', sortOrder: 2 },
  { id: 'breast-cosmetic', title: 'Section 4: Breast & Cosmetic', sortOrder: 3 },
  { id: 'core-surgical', title: 'Section 5: Core Surgical Principles', sortOrder: 4 },
];

export const subsectionTitles: Record<string, string> = {
  'anatomy': 'Anatomy',
  'skin-lesions': 'Skin Lesions',
  'flaps-and-grafts': 'Flaps & Grafts',
  'microsurgery': 'Microsurgery',
  'infections': 'Infections',
  'burns': 'Burns',
  'trunk': 'Trunk',
  'gender-affirming-surgery': 'Gender-Affirming Surgery',
  'vascular-anomalies': 'Vascular Anomalies',
  'hand-digit-trauma': 'Hand & Digit Trauma',
  'hand-nerves': 'Hand Nerves',
  'hand-tendons': 'Hand Tendons',
  'replantation-vascular': 'Replantation & Vascular',
  'wrist-forearm-injuries': 'Wrist & Forearm Injuries',
  'hand-tumors': 'Hand Tumors',
  'hand-inflammation-infections': 'Hand Inflammation & Infections',
  'congenital-pediatric-hand': 'Congenital & Pediatric Hand',
  'lower-extremity': 'Lower Extremity',
  'cleft-lip-palate': 'Cleft Lip & Palate',
  'facial-fractures': 'Facial Fractures',
  'facial-paralysis': 'Facial Paralysis',
  'ear-reconstruction': 'Ear Reconstruction',
  'mandible-dental-orthognathic': 'Mandible, Dental, & Orthognathic',
  'head-neck-tumors': 'Head & Neck Tumors',
  'congenital-syndromes': 'Congenital Syndromes',
  'breast-augmentation': 'Breast Augmentation',
  'breast-reduction-mastopexy': 'Breast Reduction & Mastopexy',
  'breast-reconstruction': 'Breast Reconstruction',
  'facial-rejuvenation': 'Facial Rejuvenation',
  'rhinoplasty': 'Rhinoplasty',
  'eye-aesthetic-reconstructive': 'Eye Aesthetic & Reconstructive',
  'body-contouring': 'Body Contouring',
  'anesthesia': 'Anesthesia',
  'perioperative-care': 'Perioperative Care',
  'critical-care': 'Critical Care',
  'trauma': 'Trauma',
  'transplantation': 'Transplantation',
  'statistics-ethics-practice': 'Statistics, Ethics, & Practice Management',
};

export const subsectionOrder = Object.keys(subsectionTitles);

export const subsectionToSection: Record<string, string> = {};
for (const v of Object.values(categoryMapping)) {
  subsectionToSection[v.subsection] = v.section;
}
