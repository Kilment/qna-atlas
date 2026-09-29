import { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { useSections } from '@/hooks/useSections';
import { Section } from '@/types/question';
import { useSpacedRepetition } from '@/hooks/useSpacedRepetition';
import { useQuestionStats } from '@/hooks/useQuestionStats';
import { parseQuestionForReview } from '@/utils/parseQuestionForReview';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  ArrowLeft,
  Lightbulb,
  CheckCircle2,
  XCircle,
  RotateCcw,
  FlipVertical2,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { toast } from 'sonner';
import { normalizeAnswerExplanationForDisplay } from '@shared/questionFormat';
import { ThemeSwitcher } from '@/components/ui/theme-switcher';
import { QuestionImage } from '@/components/QuestionImage';
import { questionMarkdownComponents, questionMarkdownInlineComponents, questionMarkdownExplanationComponents } from '@/components/markdownComponents';

interface SpacedRepetitionProps {
  onBack: () => void;
}

type ReviewItem = {
  question: Section['subsections'][0]['questions'][0];
  sectionId: string;
  sectionTitle: string;
  subsectionId: string;
  subsectionTitle: string;
};

export function SpacedRepetitionPage({ onBack }: SpacedRepetitionProps) {
  const { dueQuestions, reviewedQuestionIds, incorrectQuestionIds, isLoading, updateSR, isPending } =
    useSpacedRepetition();
  const { recordResponse } = useQuestionStats();
  const { sections } = useSections();
  const [searchQuery, setSearchQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [explanationExpanded, setExplanationExpanded] = useState(true);
  /** After reveal, keep MCQ result styling on the question side (Flip Back). */
  const [showOutcomeOnFront, setShowOutcomeOnFront] = useState(false);
  const [selectedConfidence, setSelectedConfidence] = useState<number | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollTopToRestoreRef = useRef<number | null>(null);
  const reviewCardRef = useRef<HTMLDivElement>(null);

  const dueIds = useMemo(() => new Set((dueQuestions ?? []).map((d) => d.questionId)), [dueQuestions]);
  const reviewedIds = useMemo(
    () => new Set(Array.isArray(reviewedQuestionIds) ? reviewedQuestionIds : []),
    [reviewedQuestionIds]
  );
  const incorrectIds = useMemo(
    () => new Set(Array.isArray(incorrectQuestionIds) ? incorrectQuestionIds : []),
    [incorrectQuestionIds]
  );

  const toReview = useMemo((): ReviewItem[] => {
    if (!sections?.length) return [];

    const pool: ReviewItem[] = [];
    for (const section of sections) {
      const subsections = section?.subsections ?? [];
      for (const subsection of subsections) {
        const questions = subsection?.questions ?? [];
        for (const question of questions) {
          if (!question?.id || !incorrectIds.has(question.id)) continue;
          const isDue = dueIds.has(question.id);
          const neverReviewed = !reviewedIds.has(question.id);
          if (isDue || neverReviewed) {
            pool.push({
              question,
              sectionId: section.id ?? '',
              sectionTitle: section.title ?? '',
              subsectionId: subsection.id ?? '',
              subsectionTitle: subsection.title ?? '',
            });
          }
        }
      }
    }

    const dueOrder = new Map((dueQuestions ?? []).map((d, i) => [d.questionId, i]));
    pool.sort((a, b) => {
      const aDue = dueOrder.get(a.question.id);
      const bDue = dueOrder.get(b.question.id);
      if (aDue !== undefined && bDue !== undefined) return aDue - bDue;
      if (aDue !== undefined) return -1;
      if (bDue !== undefined) return 1;
      return 0;
    });
    return pool;
  }, [sections, dueIds, reviewedIds, incorrectIds, dueQuestions]);

  const filtered = useMemo(() => {
    if (!searchQuery) return toReview;
    const q = searchQuery.toLowerCase();
    return toReview.filter((item) => {
      const questionText = item.question?.question ?? '';
      const answerText = item.question?.answer ?? '';
      return (
        questionText.toLowerCase().includes(q) ||
        answerText.toLowerCase().includes(q) ||
        (item.sectionTitle ?? '').toLowerCase().includes(q) ||
        (item.subsectionTitle ?? '').toLowerCase().includes(q)
      );
    });
  }, [toReview, searchQuery]);

  const current = filtered[currentIndex];
  const parsed = current ? parseQuestionForReview(current.question) : null;

  useEffect(() => {
    setExplanationExpanded(true);
  }, [current?.question.id, flipped]);

  useEffect(() => {
    setShowOutcomeOnFront(false);
    setSelectedConfidence(null);
  }, [current?.question.id]);

  // Keep index in range when the queue shrinks after a review is saved.
  useEffect(() => {
    if (filtered.length === 0) {
      if (currentIndex !== 0) setCurrentIndex(0);
      return;
    }
    if (currentIndex >= filtered.length) {
      setCurrentIndex(filtered.length - 1);
    }
  }, [filtered.length, currentIndex]);

  useLayoutEffect(() => {
    if (scrollTopToRestoreRef.current == null) return;
    const y = scrollTopToRestoreRef.current;
    scrollTopToRestoreRef.current = null;
    const el = scrollAreaRef.current;
    if (el) el.scrollTop = y;
  }, [selectedAnswer]);

  /** After flip (either side), align card top to the scroll viewport. */
  useLayoutEffect(() => {
    const card = reviewCardRef.current;
    const scroller = scrollAreaRef.current;
    if (!card || !scroller) return;
    const scRect = scroller.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const delta = cardRect.top - scRect.top;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }, [flipped, current?.question.id, showOutcomeOnFront]);

  const hasChoices = (parsed?.choices.length ?? 0) > 0;
  const correctAnswer = parsed?.correctAnswer ?? null;
  const isCorrect =
    hasChoices && selectedAnswer && correctAnswer
      ? selectedAnswer.toUpperCase() === correctAnswer
      : null;

  const canReveal = hasChoices ? !!selectedAnswer : true;
  const showMcqResults = Boolean(showOutcomeOnFront && selectedAnswer && hasChoices);

  const handleReveal = () => {
    if (!canReveal || !current) return;
    setShowOutcomeOnFront(true);
    setFlipped(true);
  };

  const answerChosenForCard = hasChoices ? !!selectedAnswer : showOutcomeOnFront;
  const canCommitReview = Boolean(
    current && selectedConfidence !== null && answerChosenForCard
  );

  const handleConfidenceSelect = (quality: number) => {
    setSelectedConfidence(quality);
  };

  const commitReviewAndAdvance = async () => {
    if (!current || selectedConfidence === null || !answerChosenForCard) return;

    const wasLastCard = currentIndex >= filtered.length - 1;

    try {
      if (hasChoices && selectedAnswer && correctAnswer) {
        recordResponse({
          questionId: current.question.id,
          sectionId: current.sectionId,
          subsectionId: current.subsectionId,
          selectedAnswer,
          correctAnswer,
          isCorrect: isCorrect ?? false,
        });
      }

      await updateSR(
        current.question.id,
        current.sectionId,
        current.subsectionId,
        selectedConfidence
      );

      // Reviewed cards leave the due queue after update. Keep the same index so the
      // next item slides into place — incrementing here skips a card or shows blank.
      setSelectedConfidence(null);
      setFlipped(false);
      setSelectedAnswer(null);
      setShowOutcomeOnFront(false);

      if (wasLastCard) {
        toast.success('Review complete!');
        setCurrentIndex(0);
      }
    } catch (error) {
      toast.error('Failed to save review.');
      console.error(error);
    }
  };

  const resetCard = () => {
    setFlipped(false);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-gradient-to-br from-purple-400/20 via-lavender-300/20 to-pink-300/20">
      <div className="p-4 md:p-6 border-b border-border/40 backdrop-blur-sm shrink-0">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              data-testid="button-back-spaced-repetition"
              className="shrink-0"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
              <Lightbulb className="h-5 w-5 shrink-0 text-primary sm:h-6 sm:w-6" />
              <h1 className="truncate text-base font-bold leading-tight text-foreground sm:text-lg md:text-2xl lg:text-3xl">
                Spaced Repetition
              </h1>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 sm:justify-end sm:gap-5">
            <ThemeSwitcher />
            <div className="text-right">
              <p className="text-xs text-muted-foreground sm:text-sm">Remaining Questions</p>
              <p className="text-xl font-bold text-primary sm:text-2xl">
                {sections.length > 0 ? filtered.length : incorrectIds.size}
              </p>
            </div>
          </div>
        </div>
        <Input
          type="text"
          placeholder="Search Review Questions"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setCurrentIndex(0);
            setFlipped(false);
            setSelectedAnswer(null);
            setShowOutcomeOnFront(false);
            setSelectedConfidence(null);
          }}
          className="border border-white/35 bg-white/35 shadow-sm backdrop-blur-md ring-1 ring-black/5 dark:border-white/20 dark:bg-white/15 dark:ring-white/10"
          data-testid="input-search-spaced-repetition"
        />
      </div>

      <div
        ref={scrollAreaRef}
        className="flex-1 overflow-auto [overflow-anchor:none] p-4 md:p-6 flex flex-col"
      >
        {(isLoading || toReview.length === 0 || (filtered.length === 0 && !!searchQuery)) && (
          <div className="flex-1 flex items-center justify-center p-4">
            {isLoading && sections.length === 0 && (
              <div className="text-center space-y-4">
                <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full mx-auto" />
                <p className="text-muted-foreground">Loading questions...</p>
              </div>
            )}
            {!isLoading && toReview.length === 0 && (
              <Card variant="glass" className="p-8 text-center max-w-2xl">
                <Lightbulb className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <h2 className="text-xl font-semibold text-foreground mb-2">All Caught Up</h2>
                <p className="text-muted-foreground">
                  {sections.length === 0
                    ? 'Load questions to get started.'
                    : "You haven't missed any questions yet. Answer incorrectly in test or study mode to add them here."}
                </p>
              </Card>
            )}
            {!isLoading && filtered.length === 0 && toReview.length > 0 && searchQuery && (
              <Card variant="glass" className="p-8 text-center max-w-2xl">
                <p className="text-muted-foreground">No questions match your search.</p>
              </Card>
            )}
          </div>
        )}

        {!isLoading && filtered.length > 0 && current && parsed && (
          <div className="max-w-2xl mx-auto w-full pb-4">
            {/* Progress above card */}
            <div className="flex justify-between items-center text-sm text-muted-foreground mb-4">
              <span>
                {currentIndex + 1} / {filtered.length}
              </span>
              <span>
                {current.sectionTitle} → {current.subsectionTitle}
              </span>
            </div>

            {/* Single expanding card: question side or answer side (no fixed height; page scrolls) */}
            {!flipped ? (
              <Card ref={reviewCardRef} variant="glass" className="p-6">
                <div className="text-lg font-semibold text-foreground mb-4">
                  <ReactMarkdown
                    skipHtml
                    components={questionMarkdownComponents}
                  >
                    {parsed.text}
                  </ReactMarkdown>
                </div>

                {current.question.imageUrl && (
                  <QuestionImage
                    src={current.question.imageUrl}
                    alt={current.question.imageAlt ?? 'Clinical image'}
                    attribution={current.question.imageAttribution}
                    className="mb-4"
                  />
                )}

                {hasChoices ? (
                  <div className="mt-4 w-full space-y-2.5">
                    {parsed.choices.map((choice) => {
                      const isThisChoice = choice.letter === selectedAnswer;
                      const isCorrectChoice = Boolean(correctAnswer && choice.letter === correctAnswer);
                      const showRedRow = showMcqResults && isThisChoice && isCorrect === false;
                      const showGreenRow = showMcqResults && isCorrectChoice;
                      const isSelectedPending = !showMcqResults && isThisChoice;
                      const canPick = !showMcqResults;

                      return (
                        <div
                          key={choice.letter}
                          role={canPick ? 'button' : undefined}
                          tabIndex={canPick ? 0 : undefined}
                          onClick={
                            canPick
                              ? () => {
                                  const el = scrollAreaRef.current;
                                  scrollTopToRestoreRef.current = el ? el.scrollTop : null;
                                  setSelectedAnswer(choice.letter);
                                }
                              : undefined
                          }
                          onKeyDown={
                            canPick
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    const el = scrollAreaRef.current;
                                    scrollTopToRestoreRef.current = el ? el.scrollTop : null;
                                    setSelectedAnswer(choice.letter);
                                  }
                                }
                              : undefined
                          }
                          className={cn(
                            'w-full rounded-xl border-2 transition-colors overflow-hidden text-left',
                            !showMcqResults && !isSelectedPending && 'border-border bg-background',
                            canPick && !isSelectedPending && 'hover:bg-accent/[0.04]',
                            !showMcqResults && isSelectedPending && 'border-primary bg-primary/5 shadow-sm',
                            showRedRow && 'border-red-500 bg-red-50 dark:border-red-500 dark:bg-red-950/35',
                            showGreenRow && 'border-green-600 bg-green-50 dark:border-green-600 dark:bg-green-950/30',
                            showMcqResults && !showRedRow && !showGreenRow && 'border-border bg-background',
                            canPick ? 'cursor-pointer' : 'cursor-default'
                          )}
                        >
                          <div
                            className={cn(
                              'flex w-full items-center gap-2.5 p-2.5 md:gap-3 md:px-3.5 md:py-3 min-h-[2.75rem] md:min-h-12',
                            )}
                          >
                            <span
                              className={cn(
                                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold leading-none md:h-8 md:w-8 md:text-sm',
                                !showMcqResults && !isSelectedPending &&
                                  'border-2 border-muted-foreground/25 bg-background text-foreground',
                                !showMcqResults && isSelectedPending && 'border-0 bg-primary text-primary-foreground',
                                showRedRow && 'bg-red-500 text-white shadow-sm',
                                showGreenRow && 'bg-green-600 text-white shadow-sm',
                                showMcqResults &&
                                  !showRedRow &&
                                  !showGreenRow &&
                                  'border-2 border-muted-foreground/20 bg-muted/50 text-muted-foreground',
                              )}
                              aria-hidden
                            >
                              {choice.letter}
                            </span>
                            <div
                              className={cn(
                                'min-w-0 flex-1 text-sm leading-snug md:text-base',
                                showGreenRow && 'font-medium text-green-800 dark:text-green-200',
                                showRedRow && 'text-foreground',
                              )}
                            >
                              <ReactMarkdown
                                skipHtml
                                components={questionMarkdownInlineComponents}
                              >
                                {choice.text}
                              </ReactMarkdown>
                            </div>
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
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No answer choices, reveal card to see the answer.
                  </p>
                )}

                <div className="mt-6 flex gap-3">
                  <Button
                    variant={hasChoices ? 'outline' : 'default'}
                    onClick={showOutcomeOnFront ? () => setFlipped(true) : handleReveal}
                    disabled={!showOutcomeOnFront && !canReveal}
                    data-testid="button-show-answer-spaced-rep"
                    className="flex-1"
                  >
                    <FlipVertical2 className="mr-2 h-4 w-4 shrink-0" aria-hidden />
                    Show Answer
                  </Button>
                </div>
              </Card>
            ) : (
              <Card ref={reviewCardRef} variant="glass" className="overflow-hidden p-6">
                <div className="space-y-4">
                  <div className="-mx-6" data-testid="spaced-repetition-explanation-panel">
                    <div className="flex flex-wrap items-center justify-between gap-2 bg-background/80 px-4 py-3 md:px-6 border-b border-border backdrop-blur-sm">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {isCorrect === true && (
                          <>
                            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400" aria-hidden />
                            <span className="text-sm font-semibold text-green-700 dark:text-green-300">Correct</span>
                          </>
                        )}
                        {isCorrect === false && (
                          <>
                            <XCircle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
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
                        className="h-8 shrink-0 gap-1.5"
                        onClick={() => setExplanationExpanded((e) => !e)}
                        data-testid="button-toggle-explanation-sr"
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
                            {normalizeAnswerExplanationForDisplay(current.question?.answer ?? '')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="pt-4 border-t border-border">
                    <p className="text-sm font-medium text-foreground mb-3">How Confident Were You?</p>
                    <div className="grid grid-cols-3 gap-2">
                      {[0, 1, 2, 3, 4, 5].map((q) => {
                        const isSel = selectedConfidence === q;
                        return (
                          <Button
                            key={q}
                            variant={
                              isSel ? (q === 0 ? 'destructive' : q === 5 ? 'default' : 'outline') : 'outline'
                            }
                            size="sm"
                            onClick={() => handleConfidenceSelect(q)}
                            disabled={isPending}
                            className={cn(
                              'h-9',
                              isSel && q > 0 && q < 5 && 'border-primary bg-primary/15 font-semibold text-primary'
                            )}
                            data-testid={`button-confidence-${q}`}
                          >
                            {q}
                          </Button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      1 = No Idea, 3 = Vague Recall, 5 = Perfect
                    </p>
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetCard}
                  className="mt-4 self-start"
                  data-testid="button-flip-back"
                >
                  <RotateCcw className="h-4 w-4 mr-1" /> Flip Back
                </Button>
              </Card>
            )}

            <div className="flex justify-between mt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setCurrentIndex(Math.max(0, currentIndex - 1));
                  setFlipped(false);
                  setSelectedAnswer(null);
                  setShowOutcomeOnFront(false);
                  setSelectedConfidence(null);
                }}
                disabled={currentIndex === 0}
                data-testid="button-prev"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                onClick={() => void commitReviewAndAdvance()}
                disabled={!canCommitReview || isPending}
                data-testid="button-next"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
