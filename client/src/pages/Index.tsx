import { useState, useEffect, useRef } from 'react';
import { useSections } from '@/hooks/useSections';
import { useTheme } from '@/hooks/useTheme';
import { useSpecialty } from '@/hooks/useSpecialty';
import { ThemeSwitcher } from '@/components/ui/theme-switcher';
import { SpecialtySwitcher } from '@/components/SpecialtySwitcher';
import atlasLogo from '@assets/atlas_1764093111680.png';
import atlasLogoLight from '@assets/logo_light_1774918799268.png';
import { Section } from '@/types/question';
import { Navigation } from '@/components/Navigation';
import { QuestionCard } from '@/components/QuestionCard';
import { QuestionStats } from '@/components/QuestionStats';
import { QuestionFilters } from '@/components/QuestionFilters';
import { SearchResults } from '@/components/SearchResults';
import { HomePage } from '@/components/HomePage';
import { Paywall } from '@/components/Paywall';
import { PreviewWizard } from '@/components/PreviewWizard';
import { ChatBubble } from '@/components/ChatBubble';
import { TestMode } from './TestMode';
import { Settings as SettingsPage } from './Settings';
import SubscriptionPage from './SubscriptionPage';
import { Input } from '@/components/ui/input';
import {
  Search,
  Home,
  FileText,
  Settings,
  Lightbulb,
  Mic,
  Menu,
  X,
  PanelLeftOpen,
  PanelLeftClose,
} from 'lucide-react';
import { BookmarkAnimatedIcon } from '@/components/ui/bookmark-icon-button';
import { Button } from '@/components/ui/button';
import { useQuestionStats } from '@/hooks/useQuestionStats';
import { useHighlights } from '@/hooks/useHighlights';
import { useGlobalSearch } from '@/hooks/useGlobalSearch';
import { useBookmarks } from '@/hooks/useBookmarks';
import { useSpacedRepetition } from '@/hooks/useSpacedRepetition';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { queryClient, apiRequest, withSpecialtyQuery } from '@/lib/queryClient';

type FilterMode = 'all' | 'incorrect' | 'unanswered';
type ScreenMode = 'study' | 'test' | 'settings' | 'preview';
type TestModeState = { mode: 'new' } | { mode: 'resume'; sessionId: string };

export default function Index() {
  const [, setLocation] = useLocation();
  const { resolvedTheme } = useTheme();
  const { specialty, activeSpecialty, isSwitching } = useSpecialty();
  const isOrthoBank = activeSpecialty === "ortho";
  const { sections, isLoading: sectionsLoading } = useSections();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [selectedSubsection, setSelectedSubsection] = useState<string | null>(null);
  const [isNavOpen, setIsNavOpen] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 1024
  );
  const isLoading = sectionsLoading || isSwitching;
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [screenMode, setScreenMode] = useState<ScreenMode>('study');
  const [testModeState, setTestModeState] = useState<TestModeState>({ mode: 'new' });
  const searchRef = useRef<HTMLDivElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const subscriptionSuccessIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { data: subscription, isLoading: isCheckingSubscription, refetch: refetchSubscription } = useQuery({
    queryKey: ['/api/subscription', activeSpecialty],
    queryFn: async () => {
      const res = await fetch(withSpecialtyQuery('/api/subscription', activeSpecialty), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        return {
          status: "none",
          daysRemaining: 0,
          trialEndsAt: null,
          isLocked: res.status === 401 || res.status === 403,
        };
      }
      return res.json();
    },
    staleTime: 0,
  });

  // When access is revoked (e.g. remove institutional), leave Settings/Test so unlock returns to study, not Settings.
  useEffect(() => {
    if (subscription?.isLocked) {
      setScreenMode('study');
    }
  }, [subscription?.isLocked]);

  // Reset study navigation when switching question banks so PRS section ids don't linger on Ortho.
  useEffect(() => {
    setSelectedSection(null);
    setSelectedSubsection(null);
    setSearchQuery('');
    setShowSearchResults(false);
    setScreenMode('study');
    setTestModeState({ mode: 'new' });
  }, [activeSpecialty]);

  const [showPreviewWizard, setShowPreviewWizard] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(window.innerWidth < 1024);
  const { bookmarks } = useBookmarks();
  const { reviewableCount } = useSpacedRepetition();
  
  // Track question element refs (scoped to current subsection)
  const questionRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  // Track last answered question per subsection (key: "section-subsection"), persisted to localStorage
  const lastAnsweredQuestionMap = useRef<Map<string, string>>(new Map());
  /** Main study column (question list); reset scroll when switching subsections via the section navigator. */
  const studyMainScrollRef = useRef<HTMLDivElement>(null);
  const scrollMainToTopFromNavigatorRef = useRef(false);

  // Load persisted last answered questions on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('lastAnsweredQuestions');
      if (stored) {
        const parsed = JSON.parse(stored);
        Object.entries(parsed).forEach(([key, value]) => {
          lastAnsweredQuestionMap.current.set(key, value as string);
        });
      }
    } catch (error) {
      console.error('Failed to load persisted last answered questions:', error);
    }
  }, []);

  const {
    recordResponse,
    getQuestionResponse,
    getSubsectionStats,
    getIncorrectQuestionIds,
    getUnansweredQuestionIds,
    resetSubsection,
    resetAll,
  } = useQuestionStats();

  const { notes } = useHighlights();
  
  // Global search across questions and notes (reference material removed for now)
  const searchResults = useGlobalSearch(sections, [], notes, searchQuery);

  // After Stripe Payment Link return: fulfill with session_id + planId, then open Settings and poll
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('subscription') !== 'success') return;

    const sessionId = params.get('session_id') ?? '';
    const planId = (() => {
      try {
        return sessionStorage.getItem('subscription_pending_plan') ?? '';
      } catch {
        return '';
      }
    })();

    const runSuccess = () => {
      try {
        sessionStorage.removeItem('subscription_pending_plan');
      } catch {}
      setScreenMode('settings');
      toast.success('Subscription active! Your plan has been updated.');
      queryClient.invalidateQueries({ queryKey: ['/api/subscription/details'] });
      queryClient.invalidateQueries({ queryKey: ['/api/subscription'] });
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);

      refetchSubscription().then(({ data }) => {
        if (data && !data.isLocked) return;
        let attempts = 0;
        subscriptionSuccessIntervalRef.current = setInterval(() => {
          attempts += 1;
          refetchSubscription().then(({ data: next }) => {
            if (next && !next.isLocked && subscriptionSuccessIntervalRef.current) {
              clearInterval(subscriptionSuccessIntervalRef.current);
              subscriptionSuccessIntervalRef.current = null;
            }
          });
          if (attempts >= 15 && subscriptionSuccessIntervalRef.current) {
            clearInterval(subscriptionSuccessIntervalRef.current);
            subscriptionSuccessIntervalRef.current = null;
          }
        }, 1500);
      });
    };

    if (sessionId) {
      apiRequest('/api/subscription/fulfill', {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId, ...(planId ? { planId } : {}) }),
      })
        .then(runSuccess)
        .catch((err) => {
          toast.error(err?.message ?? 'Could not activate subscription.');
          window.history.replaceState(null, '', window.location.pathname + window.location.hash);
        });
      return () => {
        if (subscriptionSuccessIntervalRef.current) {
          clearInterval(subscriptionSuccessIntervalRef.current);
          subscriptionSuccessIntervalRef.current = null;
        }
      };
    }

    // Webhook-only path (no session_id): still show success and poll.
    runSuccess();
    return () => {
      if (subscriptionSuccessIntervalRef.current) {
        clearInterval(subscriptionSuccessIntervalRef.current);
        subscriptionSuccessIntervalRef.current = null;
      }
    };
  }, [refetchSubscription]);

  // Handle window resize for responsive mobile layout
  useEffect(() => {
    const handleResize = () => {
      const isSmall = window.innerWidth < 1024;
      setIsMobileLayout(isSmall);

      if (isSmall) {
        setIsNavOpen(false);
        if (screenMode === 'settings') {
          setScreenMode('study');
        }
      } else {
        setIsNavOpen(true);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [screenMode]);

  // Mobile "All Content" overlay: keep scroll inside the panel; do not chain to page / rubber-band the backdrop
  useEffect(() => {
    if (!isMobileLayout || !isNavOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isMobileLayout, isNavOpen]);

  // Close search results when clicking outside (panel is portaled to body)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const inAnchor = searchRef.current?.contains(target);
      const inPanel = searchPanelRef.current?.contains(target);
      if (!inAnchor && !inPanel) {
        setShowSearchResults(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clear refs when subsection changes to ensure fresh DOM references
  useEffect(() => {
    questionRefsMap.current.clear();
  }, [selectedSection, selectedSubsection]);

  // Auto-scroll to last answered question when subsection changes (unless user picked a subsection in the nav)
  useEffect(() => {
    if (!selectedSection || !selectedSubsection) return;

    if (scrollMainToTopFromNavigatorRef.current) {
      scrollMainToTopFromNavigatorRef.current = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          studyMainScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        });
      });
      return;
    }

    const subsectionKey = `${selectedSection}-${selectedSubsection}`;
    const lastAnsweredId = lastAnsweredQuestionMap.current.get(subsectionKey);

    if (lastAnsweredId) {
      // Start with a delay to ensure React has rendered and laid out the DOM
      setTimeout(() => {
        let attempts = 0;
        const maxAttempts = 30;
        
        const tryScroll = () => {
          attempts++;
          // Use querySelector to find element by data-question-id attribute (more reliable than refs)
          const questionElement = document.querySelector(`[data-question-id="${lastAnsweredId}"]`) as HTMLElement;
          
          if (questionElement && questionElement.offsetParent !== null) {
            // Element is visible in the DOM - scroll to it
            questionElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else if (attempts < maxAttempts) {
            // Try again if not found yet
            setTimeout(tryScroll, 150);
          }
        };
        
        tryScroll();
      }, 300); // Initial delay to ensure DOM is ready
    }
  }, [selectedSection, selectedSubsection]);

  const currentSection = sections.find(s => s.id === selectedSection);
  const currentSubsection = currentSection?.subsections.find(ss => ss.id === selectedSubsection);

  // Get stats for current subsection
  const subsectionStats = currentSubsection && selectedSection && selectedSubsection
    ? getSubsectionStats(selectedSection, selectedSubsection, currentSubsection.questions.length)
    : { total: 0, answered: 0, correct: 0, incorrect: 0 };

  // Get incorrect and unanswered question IDs for filtering
  const incorrectQuestionIds = selectedSection && selectedSubsection
    ? getIncorrectQuestionIds(selectedSection, selectedSubsection)
    : [];
  
  const unansweredQuestionIds = selectedSection && selectedSubsection && currentSubsection
    ? getUnansweredQuestionIds(selectedSection, selectedSubsection, currentSubsection.questions.map(q => q.id))
    : [];

  // Apply search and filter
  let filteredQuestions = currentSubsection?.questions || [];
  
  // Apply filter based on mode
  if (filterMode === 'incorrect') {
    filteredQuestions = filteredQuestions.filter(q => incorrectQuestionIds.includes(q.id));
  } else if (filterMode === 'unanswered') {
    filteredQuestions = filteredQuestions.filter(q => unansweredQuestionIds.includes(q.id));
  }
  
  // Apply search filter only when in a subsection (local search)
  if (searchQuery && selectedSubsection) {
    filteredQuestions = filteredQuestions.filter(q =>
      q.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
      q.answer.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }

  const handleAnswerSubmit = (questionId: string, selectedAnswer: string, correctAnswer: string, isCorrect: boolean) => {
    if (selectedSection && selectedSubsection) {
      recordResponse({
        questionId,
        sectionId: selectedSection,
        subsectionId: selectedSubsection,
        selectedAnswer,
        correctAnswer,
        isCorrect,
      });
      // Track last answered question for this subsection
      const subsectionKey = `${selectedSection}-${selectedSubsection}`;
      lastAnsweredQuestionMap.current.set(subsectionKey, questionId);
      
      // Persist to localStorage
      try {
        const stored: Record<string, string> = {};
        lastAnsweredQuestionMap.current.forEach((value, key) => {
          stored[key] = value;
        });
        localStorage.setItem('lastAnsweredQuestions', JSON.stringify(stored));
      } catch (error) {
        console.error('Failed to persist last answered question:', error);
      }
    }
  };

  const handleResetSubsection = () => {
    if (selectedSection && selectedSubsection) {
      resetSubsection(selectedSection, selectedSubsection);
      toast.success('Section progress reset.');
    }
  };

  const handleResetAll = () => {
    resetAll();
    toast.success('All progress reset.');
  };

  const handleNavigate = (
    sectionId: string,
    subsectionId: string,
    options?: { scrollMainToTop?: boolean },
  ) => {
    const selectionChanges =
      selectedSection !== sectionId || selectedSubsection !== subsectionId;

    if (options?.scrollMainToTop) {
      if (selectionChanges) {
        scrollMainToTopFromNavigatorRef.current = true;
      } else {
        queueMicrotask(() => {
          requestAnimationFrame(() => {
            studyMainScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
          });
        });
      }
    }

    setSelectedSection(sectionId);
    setSelectedSubsection(subsectionId);
    setSearchQuery('');
    if (isMobileLayout) {
      setIsNavOpen(false);
    }
    setFilterMode('all'); // Reset filter when navigating
    setShowSearchResults(false);
  };

  const handleGoHome = () => {
    if (selectedSection === null && selectedSubsection === null) {
      // Already on home screen, refresh the page
      window.location.reload();
    } else {
      // Navigate to home screen
      setSelectedSection(null);
      setSelectedSubsection(null);
      if (isMobileLayout) {
        setIsNavOpen(false);
      }
    }
  };

  const handleReviewIncorrect = () => {
    // Find first section/subsection with incorrect answers
    for (const section of sections) {
      for (const subsection of section.subsections) {
        const incorrectIds = getIncorrectQuestionIds(section.id, subsection.id);
        if (incorrectIds.length > 0) {
          setSelectedSection(section.id);
          setSelectedSubsection(subsection.id);
          setFilterMode('incorrect');
          if (isMobileLayout) {
            setIsNavOpen(false);
          }
          return;
        }
      }
    }
  };

  const handleSearchResultClick = (
    sectionId: string, 
    subsectionId: string, 
    questionId?: string, 
    noteId?: string
  ) => {
    handleNavigate(sectionId, subsectionId);
    
    // Scroll to specific element after navigation
    setTimeout(() => {
      if (questionId) {
        // Scroll to specific question
        const questionElement = document.querySelector(`[data-question-id="${questionId}"]`);
        if (questionElement) {
          questionElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Add highlight effect
          questionElement.classList.add('ring-2', 'ring-primary', 'ring-offset-2');
          setTimeout(() => {
            questionElement.classList.remove('ring-2', 'ring-primary', 'ring-offset-2');
          }, 2000);
        }
      } else if (noteId) {
        // Scroll to specific note
        const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
        if (noteElement) {
          noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Add highlight effect
          noteElement.classList.add('ring-2', 'ring-primary');
          setTimeout(() => {
            noteElement.classList.remove('ring-2', 'ring-primary');
          }, 2000);
        }
      }
    }, 300); // Wait for navigation and render
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (value.trim().length >= 2) {
      setShowSearchResults(true);
    } else {
      setShowSearchResults(false);
    }
  };

  const handleResumeTest = (sessionId: string) => {
    setTestModeState({ mode: 'resume', sessionId });
    setScreenMode('test');
  };

  const handleStartTest = () => {
    setTestModeState({ mode: 'new' });
    setScreenMode('test');
  };

  // No active plan: show subscription UI at / (no redirect so URL stays / and sign-in doesn’t send user back to /subscribe)
  if (!isCheckingSubscription && subscription?.isLocked) {
    return (
      <SubscriptionPage
        onSubscriptionUnlocked={async () => {
          await refetchSubscription();
        }}
      />
    );
  }

  if (screenMode === 'test') {
    if (sectionsLoading) {
      return (
        <div className="flex h-full min-h-0 w-full items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <TestMode 
          sections={sections} 
          onBack={() => {
            setScreenMode('study');
            setTestModeState({ mode: 'new' });
          }}
          resumeSessionId={testModeState.mode === 'resume' ? testModeState.sessionId : undefined}
        />
      </div>
    );
  }

  if (screenMode === 'settings') {
    return (
      <div className="flex h-full min-h-0 overflow-hidden">
        <SettingsPage 
          onBack={() => setScreenMode('study')}
          subscription={subscription}
        />
      </div>
    );
  }

  if (screenMode === 'preview') {
    const { getPreviewQuestions } = require('@/utils/previewQuestions');
    const previewQuestions = getPreviewQuestions(sections);
    return (
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <TestMode 
          sections={sections}
          previewQuestions={previewQuestions}
          onBack={() => setScreenMode('study')}
          isPreview={true}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PreviewWizard
        open={showPreviewWizard}
        onClose={() => setShowPreviewWizard(false)}
        onStart={() => {
          setShowPreviewWizard(false);
          setScreenMode('preview');
        }}
      />

      {/* Header - Full Width (liquid glass) */}
      <header className="glass-nav relative z-50 w-full static rounded-b-2xl sm:sticky sm:top-0">
          <div className="container mx-auto px-4 sm:px-6 lg:px-8 pt-3 pb-2">
            {/* Top Row: Home, Title, Actions */}
            <div className="flex flex-nowrap items-center gap-2 sm:gap-4 min-w-0">
              {/* Left Section */}
              <div className="flex flex-nowrap items-center gap-2 sm:gap-3 min-w-0 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.preventDefault();
                    handleGoHome();
                    (e.currentTarget as HTMLButtonElement).blur();
                  }}
                  className="hidden sm:inline-flex hover:bg-primary/20 hover:text-primary flex-shrink-0 outline-none focus-visible:ring-0 rounded-xl transition-colors"
                  title="Go to Dashboard"
                >
                  <Home className="h-5 w-5" />
                </Button>

                {/* lg+: sidebar toggle in header. Below lg: toggle is on the search row (Menu / X). */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsNavOpen((open) => !open)}
                  className="hidden lg:inline-flex hover:bg-primary/20 hover:text-primary flex-shrink-0 outline-none focus-visible:ring-0 rounded-xl transition-colors"
                  title={isNavOpen ? 'Hide all content navigation' : 'Show all content navigation'}
                  data-testid="button-toggle-nav"
                  aria-expanded={isNavOpen}
                  aria-controls="study-navigation-panel"
                >
                  {isNavOpen ? (
                    <PanelLeftClose className="h-5 w-5" aria-hidden />
                  ) : (
                    <PanelLeftOpen className="h-5 w-5" aria-hidden />
                  )}
                </Button>
                
                <button
                  type="button"
                  onClick={handleGoHome}
                  className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 sm:pointer-events-none sm:cursor-default sm:px-4"
                  title="Go to Dashboard"
                  aria-label="Go to Dashboard"
                  data-testid="button-logo-home"
                >
                  <div className="logo-glass flex items-center justify-center p-1.5 flex-shrink-0 ring-1 ring-black/5 dark:ring-white/10">
                    <img 
                      src={resolvedTheme === 'dark' ? atlasLogoLight : atlasLogo} 
                      alt="Atlas Logo" 
                      className="h-7 w-7 sm:h-8 sm:w-8 object-contain"
                    />
                  </div>
                  <div className="hidden sm:flex flex-col min-w-0">
                    <span className="text-base sm:text-lg font-bold tracking-tight gradient-text leading-tight truncate">
                      Atlas Review
                    </span>
                    <span className="text-xs font-medium text-muted-foreground tracking-tight truncate">
                      {specialty.specialtyName}
                    </span>
                  </div>
                </button>
              </div>

              {/* Spacer */}
              <div className="flex-1"></div>

              {/* Right Section */}
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <ThemeSwitcher />
                <SpecialtySwitcher className="hidden sm:inline-flex flex-shrink-0" />

                {/* Settings Button */}
                <Button
                  onClick={() => setScreenMode('settings')}
                  variant="outline"
                  size="icon"
                  className="flex-shrink-0"
                  title="Settings"
                  data-testid="button-settings"
                >
                  <Settings className="h-5 w-5" />
                </Button>

                {/* Bookmarks Button */}
                <Button
                  onClick={() => setLocation('/bookmarks')}
                  variant="outline"
                  className="gap-2 relative"
                  data-testid="button-bookmarks"
                >
                  <BookmarkAnimatedIcon isSaved={bookmarks.length > 0} size={16} />
                  <span className="hidden md:inline">Bookmarks</span>
                  {bookmarks.length > 0 && (
                    <span className="absolute -top-2 -right-2 bg-accent text-accent-foreground text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">
                      {bookmarks.length > 99 ? '99+' : bookmarks.length}
                    </span>
                  )}
                </Button>

                {/* Spaced Repetition Button */}
                <Button
                  onClick={() => setLocation('/spaced-repetition')}
                  variant="outline"
                  className="gap-2 relative"
                  data-testid="button-spaced-repetition"
                >
                  <Lightbulb className="h-4 w-4" />
                  <span className="hidden md:inline">Review</span>
                  {reviewableCount > 0 && (
                    <span className="absolute -top-2 -right-2 bg-primary text-primary-foreground text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">
                      {reviewableCount > 99 ? '99+' : reviewableCount}
                    </span>
                  )}
                </Button>

                {/* Test / Oral: shown on lg+ only; on smaller screens use icons next to search */}
                <div className="hidden lg:flex items-center gap-2">
                  <Button
                    onClick={handleStartTest}
                    variant="outline"
                    className="gap-2"
                    data-testid="button-test"
                  >
                    <FileText className="h-4 w-4" />
                    <span className="hidden md:inline">Test</span>
                  </Button>
                  {!isOrthoBank && (
                    <Button
                      onClick={() => setLocation('/oral-board')}
                      variant="outline"
                      className="gap-2"
                      data-testid="button-oral-board"
                    >
                      <Mic className="h-4 w-4" />
                      <span className="hidden md:inline">Oral Boards Coach</span>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Row: Search (questions + notes only; reference view removed) */}
          <div className="border-t border-white/40 dark:border-white/10 px-4 sm:px-6 lg:px-8 py-3 bg-white/20 dark:bg-white/5 backdrop-blur-sm min-w-0">
            <div className="w-full max-w-6xl mx-auto flex items-center gap-2 sm:gap-4 min-w-0">
              {/* Below lg (nav overlay mode): obvious menu control next to search */}
              {currentSubsection && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="lg:hidden flex-shrink-0 h-10 w-10 border-border bg-background/90 shadow-sm"
                onClick={() => setIsNavOpen((open) => !open)}
                title={isNavOpen ? 'Close all content menu' : 'Open all content menu'}
                data-testid="button-toggle-nav"
                aria-expanded={isNavOpen}
                aria-controls="study-navigation-panel"
              >
                {isNavOpen ? (
                  <X className="h-5 w-5" aria-hidden />
                ) : (
                  <Menu className="h-5 w-5" aria-hidden />
                )}
              </Button>
              )}
              <div className="relative flex-1 min-w-0 max-w-full" ref={searchRef}>
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  type="text"
                  placeholder={isMobileLayout ? "Search" : "Search All Questions, Notes, Explanations"}
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onFocus={() => {
                    if (searchQuery.trim().length >= 2) {
                      setShowSearchResults(true);
                    }
                  }}
                  className="pl-10 w-full"
                  data-testid="input-search"
                />
                {showSearchResults && searchQuery.trim().length >= 2 && (
                  <SearchResults
                    results={searchResults}
                    query={searchQuery}
                    onResultClick={handleSearchResultClick}
                    anchorRef={searchRef}
                    panelRef={searchPanelRef}
                    onDismiss={() => setShowSearchResults(false)}
                  />
                )}
              </div>

              <div className="flex lg:hidden items-center gap-2 flex-shrink-0">
                <Button
                  onClick={handleStartTest}
                  variant="outline"
                  size="icon"
                >
                  <FileText className="h-4 w-4" />
                </Button>
                {!isOrthoBank && (
                  <Button
                    onClick={() => setLocation('/oral-board')}
                    variant="outline"
                    size="icon"
                    data-testid="button-oral-board-mobile"
                    aria-label="Oral Boards Coach"
                  >
                    <Mic className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </header>

      {/* Bottom Section - Sidebar + Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* "All Content" spine: desktop (lg+) only; mobile uses header Menu next to search */}
        <button
          type="button"
          onClick={() => setIsNavOpen((open) => !open)}
          className="hidden lg:flex flex-shrink-0 rounded-none border-r border-border h-full flex-col items-center justify-center px-1.5 bg-muted/20 hover:bg-accent/40 active:bg-accent/50 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-expanded={isNavOpen}
          aria-controls="study-navigation-panel"
          title={isNavOpen ? 'Hide all content menu' : 'Show all content menu'}
        >
          <span
            className="text-xs font-semibold text-muted-foreground select-none pointer-events-none"
            style={{
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
              letterSpacing: '0.05em',
            }}
          >
            All Content
          </span>
        </button>

        {/* Navigation Sidebar - Collapsible (hidden on mobile layout) */}
        {isNavOpen && !isMobileLayout && (
          <div id="study-navigation-panel" className="w-80 flex-shrink-0 transition-all duration-300 overflow-hidden border-r border-border">
            <Navigation
              sections={sections}
              selectedSection={selectedSection}
              selectedSubsection={selectedSubsection}
              onNavigate={(sectionId, subsectionId) =>
                handleNavigate(sectionId, subsectionId, { scrollMainToTop: true })
              }
              isOpen={isNavOpen}
              onClose={() => setIsNavOpen(false)}
            />
          </div>
        )}
        
        {/* Mobile Navigation Overlay - below header, full-height safe area */}
        {isNavOpen && isMobileLayout && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50 overscroll-none"
              onClick={() => setIsNavOpen(false)}
              aria-hidden
            />
            <div
              id="study-navigation-panel"
              className="fixed left-1/2 top-[7.5rem] z-50 max-h-[calc(100vh-8.5rem)] w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto overscroll-y-contain rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur-sm sm:top-28 sm:max-h-[calc(100vh-9rem)]"
              role="dialog"
              aria-label="Content navigation"
            >
              <Navigation
                sections={sections}
                selectedSection={selectedSection}
                selectedSubsection={selectedSubsection}
                onNavigate={(sectionId, subsectionId) =>
                  handleNavigate(sectionId, subsectionId, { scrollMainToTop: true })
                }
                isOpen={isNavOpen}
                onClose={() => setIsNavOpen(false)}
              />
            </div>
          </>
        )}

        {/* Main Content Area - scrollable when on home so wheel works over empty left/right space */}
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center min-h-[400px]">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
            </div>
          ) : !currentSubsection ? (
            <div
              key="home-scroll"
              className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden scrollbar-hide"
            >
              <div className="min-h-full w-full">
                <HomePage 
                  sections={sections}
                  onNavigate={(sectionId, subsectionId) =>
                    handleNavigate(sectionId, subsectionId, { scrollMainToTop: true })
                  }
                  onReviewIncorrect={handleReviewIncorrect}
                  onStartTest={handleStartTest}
                  onResumeTest={handleResumeTest}
                  onSettings={() => setScreenMode('settings')}
                  onPreview={() => setShowPreviewWizard(true)}
                  isNavOpen={isNavOpen}
                  onToggleNav={() => setIsNavOpen((open) => !open)}
                />
              </div>
            </div>
          ) : (
            <div
              key="study-scroll"
              ref={studyMainScrollRef}
              className="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide"
            >
              <div className="container mx-auto min-w-0 max-w-full px-4 sm:px-6 lg:px-8 py-8 flex-1 min-h-0">
                <div className="space-y-4">
                  <div className="space-y-4 mb-6">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                      <div>
                        <h2 className="text-xl font-semibold text-foreground">
                          {currentSubsection.title}
                        </h2>
                        <p className="text-sm text-muted-foreground mt-1">
                          {searchQuery
                            ? `${filteredQuestions.length} ${filteredQuestions.length === 1 ? 'result' : 'results'} found`
                            : filterMode === 'incorrect'
                            ? `${filteredQuestions.length} Incorrect ${filteredQuestions.length === 1 ? 'Question' : 'Questions'}`
                            : filterMode === 'unanswered'
                            ? `${filteredQuestions.length} Unanswered ${filteredQuestions.length === 1 ? 'Question' : 'Questions'}`
                            : `${currentSubsection.questions.length} ${currentSubsection.questions.length === 1 ? 'Question' : 'Questions'}`
                          }
                        </p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <QuestionStats stats={subsectionStats} className="w-full sm:w-64" />
                      <QuestionFilters
                        filterMode={filterMode}
                        onFilterChange={setFilterMode}
                        onResetSubsection={handleResetSubsection}
                        onResetAll={handleResetAll}
                        incorrectCount={subsectionStats.incorrect}
                        unansweredCount={subsectionStats.total - subsectionStats.answered}
                      />
                    </div>
                  </div>

                  {filteredQuestions.length === 0 ? (
                    <div className="text-center py-12">
                      <p className="text-muted-foreground">
                        {searchQuery 
                          ? 'No questions match your search.' 
                          : filterMode === 'incorrect'
                          ? 'No incorrect answers yet. Start answering questions!'
                          : filterMode === 'unanswered'
                          ? 'All questions answered!'
                          : 'No questions available yet. We are cooking up some new questions for you! Please check back soon.'}
                      </p>
                    </div>
                  ) : (
                    filteredQuestions.map((question, index) => {
                      const savedResponse = getQuestionResponse(question.id);
                      return (
                        <div
                          key={question.id}
                          data-question-id={question.id}
                          ref={(el) => {
                            if (el) {
                              questionRefsMap.current.set(question.id, el);
                            }
                          }}
                        >
                          <QuestionCard
                            question={question}
                            index={index}
                            sectionId={selectedSection || ''}
                            subsectionId={selectedSubsection || ''}
                            savedResponse={savedResponse}
                            onAnswerSubmit={handleAnswerSubmit}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      {(screenMode as ScreenMode) !== 'test' && !isOrthoBank && <ChatBubble />}
    </div>
  );
}
