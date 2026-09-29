import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Question } from '@/types/question';
import { cn } from '@/lib/utils';
import { useHighlights } from '@/hooks/useHighlights';
import { useBookmarks } from '@/hooks/useBookmarks';
import { HighlightToolbar } from '@/components/HighlightToolbar';
import { StickyNote } from '@/components/StickyNote';
import { useTextHighlight } from '@/hooks/useTextHighlight';
import { QuestionResponse } from '@/hooks/useQuestionStats';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  Lightbulb,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { ReportQuestionDialog } from '@/components/ReportQuestionDialog';
import { BookmarkIconButton } from '@/components/ui/bookmark-icon-button';
import { normalizeAnswerExplanationForDisplay } from '@shared/questionFormat';
import { QuestionImage } from '@/components/QuestionImage';
import {
  questionMarkdownComponents,
  questionMarkdownInlineComponents,
  questionMarkdownExplanationComponents,
} from '@/components/markdownComponents';

interface QuestionCardProps {
  question: Question;
  index: number;
  sectionId: string;
  subsectionId: string;
  savedResponse?: QuestionResponse;
  onAnswerSubmit: (questionId: string, selectedAnswer: string, correctAnswer: string, isCorrect: boolean) => void;
  isTestMode?: boolean;
  /** Timed mock exams: confirm locks the choice without revealing correctness until exam submit/review. */
  concealResults?: boolean;
  isReadOnly?: boolean;
  isFlagged?: boolean;
  onToggleFlag?: (questionId: string) => void;
}

interface ParsedQuestion {
  text: string;
  choices: { letter: string; text: string }[];
}

export function QuestionCard({ 
  question, 
  index, 
  sectionId, 
  subsectionId, 
  savedResponse,
  onAnswerSubmit,
  isTestMode = false,
  concealResults = false,
  isReadOnly = false,
  isFlagged = false,
  onToggleFlag
}: QuestionCardProps) {
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(
    savedResponse?.selectedAnswer?.trim().toUpperCase() || null
  );
  const [showExplanation, setShowExplanation] = useState(!!savedResponse && !concealResults);
  const [answerConfirmed, setAnswerConfirmed] = useState(!!savedResponse);
  const [explanationExpanded, setExplanationExpanded] = useState(true);
  const [isEraserMode, setIsEraserMode] = useState(false);
  const [crossedOutChoices, setCrossedOutChoices] = useState<Set<string>>(new Set());
  const [reportDialogOpen, setReportDialogOpen] = useState(false);

  const {
    activeColor,
    setActiveColor,
    addHighlight,
    removeHighlight,
    batchRemoveHighlights,
    addNote,
    updateNote,
    removeNote,
    updateNotePosition,
    getHighlightsForSection,
    getNotesForSection,
  } = useHighlights();

  const { isBookmarked, toggleBookmark, isPending: isBookmarkPending } = useBookmarks();

  const highlights = getHighlightsForSection(sectionId, subsectionId, 'question', question.id);
  const notes = getNotesForSection(sectionId, subsectionId, 'question', question.id);
  const questionIsBookmarked = isBookmarked(question.id);
  const questionRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo((): ParsedQuestion => {
    let questionText = question.question;
    const choices: { letter: string; text: string }[] = [];

    // Normalize parsed letter to A-E (or A-F) for consistent RadioGroup value
    const toChoiceLetter = (captured: string): string => {
      const upper = captured.toUpperCase();
      if (/[A-F]/.test(upper)) return upper;
      const n = parseInt(captured, 10);
      if (n >= 1 && n <= 6) return String.fromCharCode(64 + n); // 1->A, 2->B, ...
      return upper;
    };

    // Match choice at line start: A), A., (A), a), 1., etc.
    const choiceLineRegex = /^([A-Fa-f1-6])\s*[.)]\s*(.+)$|^\s*\(([A-Fa-f1-6])\)\s*(.+)$/;

    const lines = questionText.split('\n');
    let choicesOnSeparateLines = false;

    for (const line of lines) {
      const m = line.match(choiceLineRegex);
      if (m && (m[2]?.trim() || m[4]?.trim())) {
        choicesOnSeparateLines = true;
        break;
      }
    }

    if (choicesOnSeparateLines) {
      const textLines: string[] = [];
      for (const line of lines) {
        const m = line.match(choiceLineRegex);
        if (m) {
          const letter = toChoiceLetter(m[1] || m[3] || '');
          const text = (m[2] || m[4] || '').trim();
          if (letter && text && /^[A-F]$/.test(letter)) {
            choices.push({ letter, text });
          }
        } else if (line.trim()) {
          textLines.push(line);
        }
      }
      questionText = textLines.join('\n');
    } else {
      const questionMarkers = ['?', ':', '.'];
      let lastMarkerIndex = -1;
      for (const marker of questionMarkers) {
        const index = questionText.lastIndexOf(marker);
        if (index > lastMarkerIndex) lastMarkerIndex = index;
      }

      if (lastMarkerIndex !== -1) {
        const beforeMarker = questionText.substring(0, lastMarkerIndex + 1);
        const afterMarker = questionText.substring(lastMarkerIndex + 1);

        // Allow A-F and 1-6, and both . and )
        const choiceMatches = Array.from(afterMarker.matchAll(/([A-Fa-f1-6])\s*[.)]\s*/g));

        if (choiceMatches.length >= 2 && choiceMatches.length <= 6) {
          const extractedChoices: { letter: string; text: string }[] = [];
          for (let i = 0; i < choiceMatches.length; i++) {
            const letter = toChoiceLetter(choiceMatches[i][1]);
            if (!/^[A-F]$/.test(letter)) continue;
            const startIndex = choiceMatches[i].index! + choiceMatches[i][0].length;
            const endIndex = i < choiceMatches.length - 1 ? choiceMatches[i + 1].index! : afterMarker.length;
            const text = afterMarker.substring(startIndex, endIndex).trim();
            if (text) extractedChoices.push({ letter, text });
          }
          if (extractedChoices.length >= 2 && extractedChoices.length <= 6) {
            choices.push(...extractedChoices);
            questionText = beforeMarker;
          }
        }
      }
    }

    return { text: questionText.trim(), choices };
  }, [question.id, question.question]);

  // Apply highlights to question text
  const questionContent = parsed.text + '\n' + parsed.choices.map(c => `${c.letter}. ${c.text}`).join('\n');
  useTextHighlight(questionRef, highlights, questionContent, isEraserMode);

  // Eraser: pointerup in capture on the question container (click alone is unreliable on touch; `closest` hits the owning mark).
  useLayoutEffect(() => {
    if (!isEraserMode) return;
    const root = questionRef.current;
    if (!root) return;

    const onPointerUpCapture = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      const mark = target.closest('mark[data-highlight-id]');
      if (!mark || !root.contains(mark)) return;
      e.preventDefault();
      e.stopPropagation();
      const highlightId = mark.getAttribute('data-highlight-id');
      if (highlightId) removeHighlight(highlightId);
    };

    root.addEventListener('pointerup', onPointerUpCapture, true);
    return () => root.removeEventListener('pointerup', onPointerUpCapture, true);
  }, [isEraserMode, removeHighlight]);

  const correctAnswer = useMemo(() => {
    // Extract correct answer from the answer text (support A-F)
    const match = question.answer.match(/(?:correct answer is|answer is|correct response is|response is)\s*(?:option\s+)?([A-F])/i);
    if (match) return match[1].toUpperCase();
    // Fallback: answer may start with "A)" or "A.\n" then explanation (e.g. AI-generated or Excel)
    const leading = question.answer.match(/^\s*([A-F])\)/);
    return leading ? leading[1].toUpperCase() : null;
  }, [question.answer]);

  const isCorrect = useMemo(() => {
    if (!selectedAnswer || !correctAnswer) return null;
    return selectedAnswer.toUpperCase() === correctAnswer;
  }, [selectedAnswer, correctAnswer]);

  // Reset state when question changes or when saved response changes
  useEffect(() => {
    if (savedResponse) {
      const normalized = savedResponse.selectedAnswer?.trim().toUpperCase();
      setSelectedAnswer(normalized || null);
      setAnswerConfirmed(true);
      setShowExplanation(!concealResults);
      setExplanationExpanded(true);
    } else {
      setSelectedAnswer(null);
      setAnswerConfirmed(false);
      setShowExplanation(false);
      setExplanationExpanded(true);
    }
  }, [savedResponse, question.id, concealResults]);

  const handleAnswerClick = () => {
    if (selectedAnswer && !answerConfirmed && correctAnswer) {
      const correct = selectedAnswer === correctAnswer;
      setAnswerConfirmed(true);
      if (!concealResults) {
        setShowExplanation(true);
        setExplanationExpanded(true);
      }
      onAnswerSubmit(question.id, selectedAnswer, correctAnswer, correct);
    }
  };

  // Autosave answer selection to database
  const handleAnswerChange = (value: string) => {
    const normalized = value.trim().toUpperCase();
    if (!normalized) return;
    setSelectedAnswer(normalized);
    // Remove cross-out if this choice was crossed out
    setCrossedOutChoices(prev => {
      const newSet = new Set(prev);
      newSet.delete(normalized);
      return newSet;
    });
    // Timed mock: after first confirm, switching choices immediately updates the saved answer
    if (concealResults && answerConfirmed && correctAnswer) {
      const correct = normalized === correctAnswer;
      onAnswerSubmit(question.id, normalized, correctAnswer, correct);
      return;
    }
    // In non-concealed test mode, changing a previously saved answer re-submits and reveals
    if (isTestMode && savedResponse && !concealResults) {
      const correct = normalized === correctAnswer;
      onAnswerSubmit(question.id, normalized, correctAnswer || '', correct);
      setAnswerConfirmed(true);
      setShowExplanation(true);
      setExplanationExpanded(true);
    }
  };

  // Handle right-click to cross out/uncross out answer choices
  const handleChoiceRightClick = (e: React.MouseEvent<HTMLDivElement>, choiceLetter: string) => {
    e.preventDefault();
    setCrossedOutChoices(prev => {
      const newSet = new Set(prev);
      if (newSet.has(choiceLetter)) {
        newSet.delete(choiceLetter);
      } else {
        newSet.add(choiceLetter);
      }
      return newSet;
    });
  };


  const flushTextHighlightSelection = useCallback(() => {
    if (isEraserMode) {
      window.getSelection()?.removeAllRanges();
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const container = questionRef.current;
    if (!container) return;

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    const raw = selection.toString();
    if (raw.trim().length < 2) return;

    const pre = document.createRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    const startOffset = pre.toString().length;
    const endOffset = startOffset + raw.length;

    addHighlight({
      text: raw.trim(),
      color: activeColor,
      sectionId,
      subsectionId,
      location: 'question',
      questionId: question.id,
      startOffset,
      endOffset,
    });

    selection.removeAllRanges();
  }, [
    isEraserMode,
    addHighlight,
    activeColor,
    sectionId,
    subsectionId,
    question.id,
  ]);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      requestAnimationFrame(() => flushTextHighlightSelection());
    },
    [flushTextHighlightSelection]
  );

  const handleAddNote = () => {
    addNote({
      content: '',
      sectionId,
      subsectionId,
      location: 'question',
      questionId: question.id,
      position: { x: 100, y: 100 },
    });
  };

  const handleClearHighlights = () => {
    batchRemoveHighlights(highlights.map(h => h.id));
  };

  return (
    <Card 
      data-question-id={question.id}
      className={cn(
        "w-full card-shadow transition-smooth overflow-hidden relative",
        "hover:elevated-shadow hover:border-primary/20"
      )}
    >
      <div className="p-4 md:p-6 space-y-3 md:space-y-4">
        <div className="flex flex-col gap-2 md:gap-3">
          <div className="flex items-center justify-between gap-3">
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 md:h-8 md:w-8"
              aria-label={`Question ${index + 1}`}
            >
              <span className="text-xs font-semibold text-primary md:text-sm">{index + 1}</span>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setReportDialogOpen(true)}
                data-testid={`button-report-${question.id}`}
                className="flex-shrink-0 transition-colors"
                title="Report question"
              >
                <AlertCircle className="h-5 w-5" />
              </Button>
              <BookmarkIconButton
                isSaved={questionIsBookmarked}
                disabled={isBookmarkPending}
                data-testid={`button-bookmark-${question.id}`}
                title="Bookmark"
                iconSize={20}
                onClick={() => {
                  void toggleBookmark(question.id, sectionId, subsectionId);
                }}
              />
            </div>
          </div>
          <div className="min-w-0 w-full">
            <div className="hidden md:block">
              <HighlightToolbar
                activeColor={activeColor}
                onColorChange={setActiveColor}
                onAddNote={handleAddNote}
                onClearHighlights={handleClearHighlights}
                isEraserMode={isEraserMode}
                onEraserToggle={() => setIsEraserMode(!isEraserMode)}
              />
            </div>
            <div className="md:hidden">
              <HighlightToolbar
                activeColor={activeColor}
                onColorChange={setActiveColor}
                onAddNote={handleAddNote}
                onClearHighlights={handleClearHighlights}
                isEraserMode={isEraserMode}
                onEraserToggle={() => setIsEraserMode(!isEraserMode)}
                isCompressed
              />
            </div>
          </div>
        </div>
        <ReportQuestionDialog
          open={reportDialogOpen}
          onOpenChange={setReportDialogOpen}
          questionId={question.id}
        />
        
        <div
          className={cn("min-w-0 w-full touch-manipulation", isEraserMode && "eraser-mode")}
          ref={questionRef}
          onPointerUp={handlePointerUp}
        >
            <div className="text-sm md:text-base leading-relaxed text-foreground mb-3 md:mb-4">
              <ReactMarkdown
                skipHtml
                components={questionMarkdownComponents}
              >
                {parsed.text}
              </ReactMarkdown>
            </div>

            {question.imageUrl && (
              <QuestionImage
                src={question.imageUrl}
                alt={question.imageAlt ?? 'Clinical image'}
                attribution={question.imageAttribution}
                className="mb-4"
              />
            )}
            
            {parsed.choices.length > 0 && (
              <RadioGroup value={selectedAnswer || ''} onValueChange={handleAnswerChange} className="w-full">
                <div className="w-full space-y-2.5">
                  {parsed.choices.map((choice) => {
                    const showResult = Boolean(selectedAnswer && showExplanation);
                    const isThisChoice = choice.letter === selectedAnswer;
                    const isCorrectChoice = Boolean(correctAnswer && choice.letter === correctAnswer);

                    const showRedRow = showResult && isThisChoice && isCorrect === false;
                    const showGreenRow = showResult && isCorrectChoice;

                    const isSelectedPending = !showResult && selectedAnswer === choice.letter;
                    const isCrossedOut = crossedOutChoices.has(choice.letter);
                    const choicesLocked = answerConfirmed && !concealResults;
                    const canSelect = !choicesLocked;
                    const showConfirmedCheck =
                      concealResults && answerConfirmed && !showExplanation && isThisChoice;

                    return (
                      <div
                        key={choice.letter}
                        data-testid={`choice-${question.id}-${choice.letter}`}
                        onContextMenu={(e) => handleChoiceRightClick(e, choice.letter)}
                        className={cn(
                          "w-full rounded-xl border-2 transition-colors overflow-hidden",
                          !showResult && !isSelectedPending && "border-border bg-background hover:bg-accent/[0.04]",
                          !showResult && isSelectedPending && "border-primary bg-primary/5 shadow-sm",
                          showRedRow && "border-red-500 bg-red-50 dark:border-red-500 dark:bg-red-950/35",
                          showGreenRow && "border-green-600 bg-green-50 dark:border-green-600 dark:bg-green-950/30",
                          showResult && !showRedRow && !showGreenRow && "border-border bg-background",
                          isCrossedOut && "opacity-50"
                        )}
                      >
                        <RadioGroupItem
                          value={choice.letter}
                          id={`${question.id}-${choice.letter}`}
                          disabled={choicesLocked}
                          className="sr-only"
                        />
                        <Label
                          htmlFor={`${question.id}-${choice.letter}`}
                          className={cn(
                            "flex items-center gap-2.5 md:gap-3 w-full min-h-[2.75rem] md:min-h-12 p-2.5 md:px-3.5 md:py-3",
                            canSelect ? "cursor-pointer" : "cursor-default"
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-7 w-7 md:h-8 md:w-8 shrink-0 rounded-full items-center justify-center text-xs md:text-sm font-bold leading-none",
                              !showResult && !isSelectedPending &&
                                "border-2 border-muted-foreground/25 text-foreground bg-background",
                              !showResult && isSelectedPending && "bg-primary text-primary-foreground border-0",
                              showRedRow && "bg-red-500 text-white shadow-sm",
                              showGreenRow && "bg-green-600 text-white shadow-sm",
                              showResult &&
                                !showRedRow &&
                                !showGreenRow &&
                                "border-2 border-muted-foreground/20 text-muted-foreground bg-muted/50"
                            )}
                            aria-hidden
                          >
                            {choice.letter}
                          </span>
                          <div
                            className={cn(
                              "flex-1 min-w-0 text-sm md:text-base leading-snug",
                              showGreenRow && "text-green-800 dark:text-green-200 font-medium",
                              showRedRow && "text-foreground",
                              isCrossedOut && "line-through text-muted-foreground"
                            )}
                          >
                            <ReactMarkdown
                              skipHtml
                              components={questionMarkdownInlineComponents}
                            >
                              {choice.text}
                            </ReactMarkdown>
                          </div>
                          {showConfirmedCheck && (
                            <Check
                              className="h-5 w-5 shrink-0 text-primary"
                              strokeWidth={2.5}
                              aria-label="Selected answer"
                            />
                          )}
                          {showRedRow && (
                            <CircleX
                              className="h-5 w-5 shrink-0 text-red-500/90 dark:text-red-400/85"
                              strokeWidth={1.35}
                              aria-label="Incorrect"
                            />
                          )}
                          {showGreenRow && (
                            <CircleCheck
                              className="h-5 w-5 shrink-0 text-green-600/90 dark:text-green-500/85"
                              strokeWidth={1.35}
                              aria-label="Correct"
                            />
                          )}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </RadioGroup>
            )}
            
            {selectedAnswer && !answerConfirmed && (
              <Button
                onClick={handleAnswerClick}
                className="mt-4"
                size="sm"
                data-testid={concealResults ? "button-confirm-answer" : "button-show-answer"}
              >
                {concealResults ? "Confirm Answer" : "Show Answer"}
              </Button>
            )}
        </div>

        {showExplanation && (
          <div
            className="-mx-4 md:-mx-6 mt-4 border-t border-border animate-in slide-in-from-top-2 duration-300"
            data-testid="question-explanation-panel"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 bg-background px-4 py-3 md:px-6 border-b border-border">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {isCorrect === true && (
                  <>
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-600 text-white shadow-sm"
                      aria-hidden
                    >
                      <Check className="h-5 w-5" strokeWidth={2.75} />
                    </span>
                    <span className="text-sm font-semibold text-green-700 dark:text-green-300">Correct</span>
                  </>
                )}
                {isCorrect === false && (
                  <>
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500 text-white shadow-sm"
                      aria-hidden
                    >
                      <X className="h-5 w-5" strokeWidth={2.75} />
                    </span>
                    <span className="text-sm font-semibold text-red-700 dark:text-red-300">Incorrect</span>
                    {correctAnswer && (
                      <span className="text-sm font-normal text-red-700/90 dark:text-red-300/90">
                        — Correct: {correctAnswer}
                      </span>
                    )}
                  </>
                )}
                {isCorrect === null && (
                  <span className="text-sm font-medium text-muted-foreground">Answer</span>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 gap-1.5 text-foreground"
                onClick={() => setExplanationExpanded((e) => !e)}
                data-testid="button-toggle-explanation"
                aria-expanded={explanationExpanded}
              >
                {explanationExpanded ? 'Hide Explanation' : 'Show Explanation'}
                {explanationExpanded ? (
                  <ChevronUp className="h-4 w-4" aria-hidden />
                ) : (
                  <ChevronDown className="h-4 w-4" aria-hidden />
                )}
              </Button>
            </div>

            {explanationExpanded && (
              <div className="bg-muted/40 px-4 py-4 md:px-6">
                <div className="mb-3 flex items-center gap-2">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
                    aria-hidden
                  >
                    <Lightbulb className="h-4 w-4" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">Explanation</p>
                </div>
                <div className="text-sm leading-relaxed text-muted-foreground">
                  <ReactMarkdown
                    skipHtml
                    components={questionMarkdownExplanationComponents}
                  >
                    {normalizeAnswerExplanationForDisplay(question.answer)}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      
      {notes.map(note => (
        <StickyNote
          key={note.id}
          id={note.id}
          content={note.content}
          position={note.position}
          onUpdate={updateNote}
          onDelete={removeNote}
          onPositionChange={updateNotePosition}
        />
      ))}
    </Card>
  );
}
