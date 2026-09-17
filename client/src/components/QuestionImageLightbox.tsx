import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';

const MIN_SCALE = 1;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;

type QuestionImageLightboxProps = {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function clearTextSelection() {
  window.getSelection()?.removeAllRanges();
}

export function QuestionImageLightbox({
  src,
  alt,
  open,
  onOpenChange,
}: QuestionImageLightboxProps) {
  const [scale, setScale] = useState(MIN_SCALE);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const resetView = useCallback(() => {
    setScale(MIN_SCALE);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    clearTextSelection();
  }, []);

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => {
      const next = Math.max(MIN_SCALE, s - SCALE_STEP);
      if (next <= MIN_SCALE) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  useEffect(() => {
    if (scale <= MIN_SCALE) {
      setPan({ x: 0, y: 0 });
    }
  }, [scale]);

  const handleOpenChange = (next: boolean) => {
    if (!next) resetView();
    onOpenChange(next);
  };

  const canPan = scale > MIN_SCALE;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canPan || e.button !== 0) return;
    e.preventDefault();
    clearTextSelection();
    dragOrigin.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.preventDefault();
    const dx = e.clientX - dragOrigin.current.x;
    const dy = e.clientY - dragOrigin.current.y;
    setPan({
      x: dragOrigin.current.panX + dx,
      y: dragOrigin.current.panY + dy,
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
    clearTextSelection();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          'max-w-[min(96vw,1200px)] w-full p-0 gap-0 overflow-hidden flex flex-col select-none',
          // Desktop: centered dialog
          'h-[min(92vh,900px)]',
          // Mobile: pin inside the visible viewport (iOS vh includes URL-bar chrome and clips the toolbar)
          'max-sm:h-[calc(100dvh-1.25rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))]',
          'max-sm:top-[max(0.75rem,env(safe-area-inset-top,0px))] max-sm:bottom-auto',
          'max-sm:translate-y-0 max-sm:data-[state=open]:slide-in-from-top-2 max-sm:data-[state=closed]:slide-out-to-top-2',
        )}
        aria-describedby={undefined}
        hideCloseButton
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2 shrink-0">
          <p className="text-sm text-muted-foreground truncate flex-1">{alt}</p>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={resetView}
              disabled={scale <= MIN_SCALE}
              aria-label="Reset zoom"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => handleOpenChange(false)}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div
          ref={viewportRef}
          className={cn(
            'flex-1 overflow-hidden bg-muted/30 touch-none',
            canPan && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
          )}
          style={{ touchAction: canPan ? 'none' : 'auto' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={() => setDragging(false)}
        >
          <div className="w-full h-full flex items-center justify-center p-4">
            <img
              src={src}
              alt={alt}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              className="max-w-full max-h-full select-none pointer-events-none"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                transformOrigin: 'center center',
                transition: dragging ? 'none' : 'transform 150ms ease',
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
