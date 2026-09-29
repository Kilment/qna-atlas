import { useState } from 'react';
import { cn } from '@/lib/utils';
import { QuestionImageLightbox } from '@/components/QuestionImageLightbox';
import type { ImageAttribution } from '@/types/question';

type QuestionImageProps = {
  src: string;
  alt?: string;
  className?: string;
  /** Credit line for open-access images (for example PubMed Central figures). */
  attribution?: ImageAttribution | null;
};

function attributionText(a: ImageAttribution): string {
  return [a.credit, a.license, a.pmcid].filter(Boolean).join(' | ');
}

export function QuestionImage({ src, alt = 'Clinical Image', className, attribution }: QuestionImageProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const credit = attribution ? attributionText(attribution) : '';
  const safeSourceUrl =
    attribution?.sourceUrl && /^https:\/\//i.test(attribution.sourceUrl) ? attribution.sourceUrl : null;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="block w-full text-left"
        aria-label={`View enlarged image: ${alt}`}
      >
        <img
          src={src}
          alt={alt}
          className="max-w-full rounded-md border cursor-pointer hover:opacity-90 transition-opacity"
        />
      </button>
      {credit && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="image-attribution">
          Image: {credit}
          {safeSourceUrl && (
            <>
              {' '}
              <a href={safeSourceUrl} target="_blank" rel="noopener noreferrer" className="underline">
                Source
              </a>
            </>
          )}
        </p>
      )}
      <QuestionImageLightbox
        src={src}
        alt={alt}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  );
}
