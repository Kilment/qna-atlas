export interface ImageAttribution {
  credit: string | null;
  license: string | null;
  sourceUrl: string | null;
  pmcid: string | null;
}

export interface Question {
  id: string;
  question: string;
  answer: string;
  category: string;
  subcategory: string;
  tags: string[];
  imageUrl?: string | null;
  imageAlt?: string | null;
  imageAttribution?: ImageAttribution | null;
}

export interface Section {
  id: string;
  title: string;
  subsections: Subsection[];
}

export interface Subsection {
  id: string;
  title: string;
  questions: Question[];
}
