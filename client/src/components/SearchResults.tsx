import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SearchResult } from '@/hooks/useGlobalSearch';
import { FileQuestion, BookOpen, StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SearchResultsProps {
  results: SearchResult[];
  query: string;
  onResultClick: (sectionId: string, subsectionId: string, questionId?: string, noteId?: string) => void;
  /** Anchor the floating panel under this element (portaled to body so it can't be covered). */
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  onDismiss?: () => void;
}

const TYPE_CONFIG = {
  question: {
    icon: FileQuestion,
    label: 'Question',
    color: 'bg-primary/10 text-primary border-primary/20',
  },
  reference: {
    icon: BookOpen,
    label: 'Reference',
    color: 'bg-accent/10 text-accent border-accent/20',
  },
  note: {
    icon: StickyNote,
    label: 'Note',
    color: 'bg-highlight-yellow/30 text-foreground border-highlight-yellow/50',
  },
};

type PanelBox = { top: number; left: number; width: number; maxHeight: number };

export function SearchResults({
  results,
  query,
  onResultClick,
  anchorRef,
  panelRef,
  onDismiss,
}: SearchResultsProps) {
  const [box, setBox] = useState<PanelBox | null>(null);

  const updatePosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 8;
    const viewportPad = 8;
    const top = rect.bottom + gap;
    const left = Math.max(viewportPad, rect.left);
    const width = Math.min(rect.width, window.innerWidth - left - viewportPad);
    const maxHeight = Math.max(160, window.innerHeight - top - viewportPad);
    setBox({ top, left, width, maxHeight });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    // capture: true so we catch scroll in nested overflow containers
    window.addEventListener('scroll', updatePosition, true);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', updatePosition);
    vv?.addEventListener('scroll', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      vv?.removeEventListener('resize', updatePosition);
      vv?.removeEventListener('scroll', updatePosition);
    };
  }, [updatePosition]);

  if (!box) return null;

  const panel = (
    <>
      {/* Sit above page glass cards; below native iOS autofill chrome (unavoidable). */}
      <div
        className="fixed inset-0 z-[199] bg-background/40"
        aria-hidden
        onMouseDown={(e) => {
          e.preventDefault();
          onDismiss?.();
        }}
        onTouchStart={(e) => {
          e.preventDefault();
          onDismiss?.();
        }}
      />
      <div
        ref={panelRef}
        data-testid="search-results-panel"
        className="fixed z-[200] pointer-events-auto"
        style={{
          top: box.top,
          left: box.left,
          width: box.width,
          maxHeight: box.maxHeight,
        }}
      >
      {results.length === 0 ? (
        <Card className="border bg-background p-4 shadow-elevated">
          <p className="text-sm text-muted-foreground text-center">
            No results found for "{query}"
          </p>
        </Card>
      ) : (
        <Card className="flex max-h-[inherit] flex-col overflow-hidden border bg-background shadow-elevated">
          <div className="shrink-0 border-b border-border bg-background p-3">
            <p className="text-sm font-semibold text-foreground">
              {results.length} {results.length === 1 ? 'result' : 'results'} found
            </p>
          </div>
          <ScrollArea className="min-h-0 flex-1" style={{ maxHeight: Math.max(120, box.maxHeight - 52) }}>
            <div className="space-y-4 p-2">
              {(['question', 'reference', 'note'] as const).map((type) => {
                const typeResults = results.filter((r) => r.type === type);
                if (typeResults.length === 0) return null;

                const config = TYPE_CONFIG[type];
                const Icon = config.icon;

                return (
                  <div key={type}>
                    <div className="mb-2 flex items-center gap-2 px-2 py-1">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-semibold uppercase text-muted-foreground">
                        {config.label}s ({typeResults.length})
                      </span>
                    </div>
                    <div className="space-y-1">
                      {typeResults.map((result, index) => (
                        <button
                          key={`${result.type}-${result.subsectionId}-${index}`}
                          type="button"
                          onClick={() =>
                            onResultClick(
                              result.sectionId,
                              result.subsectionId,
                              result.questionId,
                              result.noteId
                            )
                          }
                          className={cn(
                            'w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent/5',
                            'focus:outline-none focus:ring-2 focus:ring-ring'
                          )}
                        >
                          <div className="mb-2 flex items-start gap-2">
                            <Badge variant="outline" className={cn('text-xs', config.color)}>
                              {result.sectionTitle}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {result.subsectionTitle}
                            </span>
                          </div>
                          <p className="line-clamp-2 text-sm text-foreground/90">
                            {highlightMatch(result.matchedText, query)}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </Card>
      )}
      </div>
    </>
  );

  return createPortal(panel, document.body);
}

function highlightMatch(text: string, query: string) {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) return text;

  const before = text.substring(0, index);
  const match = text.substring(index, index + query.length);
  const after = text.substring(index + query.length);

  return (
    <>
      {before}
      <mark className="rounded bg-primary/30 px-0.5 font-semibold">{match}</mark>
      {after}
    </>
  );
}
