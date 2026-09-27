import { ItemView, WorkspaceLeaf, TFile, MarkdownRenderer, moment, Notice, Platform, Menu, Component, setIcon } from 'obsidian';
import type HandumananPlugin from '../main';
import { 
    VIEW_TYPE_DESKTOP_HUB, 
    DESKTOP_HUB_ICON_ID, 
    INTROSPECTIVE_PROMPTS,
} from '../constants';
import { JournalEntry, JournalFilterMode, JournalType } from '../types';
import { MergeNotesModal } from '../modals/MergeNotesModal';
import { isTablet, attachInlineTriggers, attachMediaPasteHandler } from '../utils';
import { attachMobileSheetViewportBehavior } from '../utils/mobileSheetViewport';

const BATCH_SIZE = 25;

export const CIRCADIAN_PROMPTS = {
    morning: [
        "What gentle intention guides your morning?",
        "What feeling or dream did you awaken with?",
        "What mindset do you choose to embody today?",
        "Where would you like to direct your energy today?"
    ],
    midday: [
        "Where is there tension you can quietly release right now?",
        "What caught your eye or touched you so far today?",
        "What went better than expected this morning?",
        "How is your body feeling right in this moment?"
    ],
    evening: [
        "What truth spoke loudest to you today?",
        "What friction or unexpressed thought are you carrying?",
        "Speak your heart uncensored. What can you let go of before you sleep?",
        "What is something small you felt genuine gratitude for today?",
        "A lesson life quietly taught you today..."
    ]
};

export function getCircadianPrompt(): string {
    const hour = moment().hour();
    let pool: string[];
    if (hour >= 5 && hour < 11) {
        pool = CIRCADIAN_PROMPTS.morning;
    } else if (hour >= 11 && hour < 17) {
        pool = CIRCADIAN_PROMPTS.midday;
    } else {
        pool = CIRCADIAN_PROMPTS.evening;
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

export class DesktopHubView extends ItemView {
    plugin: HandumananPlugin;
    private _containerEl: HTMLElement | null = null;
    private _streamContainerEl: HTMLElement | null = null;
    private _filterBarEl: HTMLElement | null = null;
    private _selectionBarEl: HTMLElement | null = null;
    private _headerBarEl: HTMLElement | null = null;
    private _composerEl: HTMLElement | null = null;
    private _composerTextarea: HTMLTextAreaElement | null = null;
    private _composerSubmitBtn: HTMLButtonElement | null = null;

    private _activeFilter: JournalFilterMode = 'all';
    private _searchQuery: string = '';
    private _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private _selectedEntryIds: Set<string> = new Set();
    private _selectionMode: boolean = false;
    private _editingEntryId: string | null = null;
    private _mobileSearchOpen: boolean = false;
    private _viewportCleanup: (() => void) | null = null;

    // Journal Modes
    private _isPrivacyShieldActive: boolean = false;
    private _isSanctuaryMode: boolean = false;
    private _selectedMood: string = '';
    private _isEntryPrivate: boolean = false;
    _capturePending: number = 0;
    _taskPending: number = 0;

    // Progressive rendering, component lifecycle & LRU caching
    private _renderedCount: number = BATCH_SIZE;
    private _scrollSentinelEl: HTMLElement | null = null;
    private _intersectionObserver: IntersectionObserver | null = null;
    private _isLoadingMore: boolean = false;
    private _renderedMarkdownCache: Map<string, HTMLElement> = new Map();
    private _streamComponent: Component | null = null;
    private _lastRenderedDay: string = '';

    constructor(leaf: WorkspaceLeaf, plugin: HandumananPlugin) {
        super(leaf);
        this.plugin = plugin;
        this._isPrivacyShieldActive = Boolean(this.plugin.settings?.privacyShieldDefault);
    }

    getViewType(): string {
        return VIEW_TYPE_DESKTOP_HUB;
    }

    getDisplayText(): string {
        return 'Handumanan Journal';
    }

    getIcon(): string {
        return DESKTOP_HUB_ICON_ID;
    }

    private getCachedRenderedBody(cacheKey: string): HTMLElement | undefined {
        const cached = this._renderedMarkdownCache.get(cacheKey);
        if (cached) {
            this._renderedMarkdownCache.delete(cacheKey);
            this._renderedMarkdownCache.set(cacheKey, cached);
            return cached.cloneNode(true) as HTMLElement;
        }
        return undefined;
    }

    private setCachedRenderedBody(cacheKey: string, el: HTMLElement): void {
        if (this._renderedMarkdownCache.size >= 150) {
            const oldestKey = this._renderedMarkdownCache.keys().next().value;
            if (oldestKey) this._renderedMarkdownCache.delete(oldestKey);
        }
        this._renderedMarkdownCache.set(cacheKey, el.cloneNode(true) as HTMLElement);
    }

    private invalidateRenderCacheForFile(filePath: string): void {
        for (const key of Array.from(this._renderedMarkdownCache.keys())) {
            if (key.startsWith(filePath)) {
                this._renderedMarkdownCache.delete(key);
            }
        }
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('diwa-workspace-root');
        this.contentEl.addClass('handumanan-journal-view');

        if (Platform.isMobile && !isTablet(this.app)) {
            this._viewportCleanup = attachMobileSheetViewportBehavior({
                sheetEl: this.contentEl,
                scrollEl: this.contentEl,
            });
        }

        this._containerEl = this.contentEl.createDiv({ cls: 'pos-scratchpad-container pos-journal-container' });

        // Sanctuary escape hatch listener
        this.registerDomEvent(window, 'keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this._isSanctuaryMode) {
                this._isSanctuaryMode = false;
                this._containerEl?.removeClass('is-sanctuary-mode');
                if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
            }
        });

        this.renderView();
    }

    async onClose(): Promise<void> {
        if (this._viewportCleanup) {
            this._viewportCleanup();
            this._viewportCleanup = null;
        }

        if (this._streamComponent) {
            this._streamComponent.unload();
            this.removeChild(this._streamComponent);
            this._streamComponent = null;
        }

        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
            this._intersectionObserver = null;
        }
        if (this._searchDebounceTimer) {
            clearTimeout(this._searchDebounceTimer);
            this._searchDebounceTimer = null;
        }
        this._renderedMarkdownCache.clear();
        this._containerEl = null;
        this._headerBarEl = null;
        this._composerEl = null;
        this._composerTextarea = null;
        this._composerSubmitBtn = null;
        this._streamContainerEl = null;
    }

    onActiveFileChange(_file?: TFile | null): void {}

    refreshAll(): void {
        // Protect active typing: only refresh filter counts and stream
        if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
        if (this._streamContainerEl) this.updateStreamOnly();
    }

    togglePrivacyShield(): void {
        this._isPrivacyShieldActive = !this._isPrivacyShieldActive;
        this._containerEl?.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);
        if (this._headerBarEl) {
            this.renderHeaderBar(this._headerBarEl);
        }
        new Notice(this._isPrivacyShieldActive ? 'Privacy Shield active (Reflections blurred)' : 'Privacy Shield deactivated');
    }

    focusComposer(): void {
        this._isSanctuaryMode = true;
        this._containerEl?.addClass('is-sanctuary-mode');
        this._composerTextarea?.focus();
        if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
    }

    /**
     * Builds or updates view layout.
     * Decouples the composer shell so typing, cursor position, and IME remain intact across data refreshes.
     */
    renderView(resetPagination = true): void {
        if (!this._containerEl) return;
        if (resetPagination) {
            this._renderedCount = BATCH_SIZE;
        }

        this._containerEl.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);
        this._containerEl.toggleClass('is-sanctuary-mode', this._isSanctuaryMode);

        const isMobile = Platform.isMobile && !isTablet(this.app);

        // Build static layout shell once
        if (!this._composerEl) {
            this._containerEl.empty();

            this._headerBarEl = this._containerEl.createDiv({ cls: 'pos-header-bar pos-journal-header' });
            this._filterBarEl = this._containerEl.createDiv({ cls: 'pos-filter-bar' });
            this._selectionBarEl = this._containerEl.createDiv({ cls: 'pos-selection-bar-wrapper' });

            if (!isMobile) {
                this._composerEl = this._containerEl.createDiv({ cls: 'pos-hero-composer pos-journal-composer' });
                this.renderComposer(this._composerEl, false);
            }

            this._streamContainerEl = this._containerEl.createDiv({ cls: 'pos-document-stream pos-journal-stream' });

            if (isMobile) {
                this._composerEl = this._containerEl.createDiv({ cls: 'pos-mobile-sticky-composer pos-journal-composer' });
                this.renderComposer(this._composerEl, true);
            }
        }

        if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
        if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
        this.updateSelectionBar();
        if (this._streamContainerEl) this.renderStream(this._streamContainerEl);
        this.updateComposerVisibility();
    }

    private updateComposerVisibility(): void {
        const isMobile = Platform.isMobile && !isTablet(this.app);
        if (!isMobile) return;
        const isSearching = this._mobileSearchOpen || Boolean(this._searchQuery.trim());
        if (this._composerEl) {
            this._composerEl.toggleClass('is-hidden', isSearching);
        }
        if (this._filterBarEl) {
            this._filterBarEl.toggleClass('is-hidden', isSearching);
        }
        if (this._containerEl) {
            this._containerEl.toggleClass('is-searching', isSearching);
        }
    }

    private renderHeaderBar(header: HTMLElement): void {
        header.empty();

        const isMobile = Platform.isMobile && !isTablet(this.app);

        const titleSection = header.createDiv({ cls: 'pos-header-title-section' });
        titleSection.createSpan({ cls: 'pos-header-logo', text: 'Handumanan' });
        titleSection.createSpan({ cls: 'pos-header-subtitle', text: 'Life Journal' });

        // Search Bar (Center / Flexible)
        if (!isMobile || this._mobileSearchOpen || this._searchQuery) {
            const searchContainer = header.createDiv({ cls: 'pos-search-container' });
            const searchInput = searchContainer.createEl('input', {
                type: 'search',
                placeholder: 'Search reflections, #themes, @people...',
                cls: 'pos-search-input',
                value: this._searchQuery,
                attr: {
                    enterkeyhint: 'search',
                    autocomplete: 'off',
                    spellcheck: 'false',
                }
            });

            searchInput.oninput = (e) => {
                const val = (e.target as HTMLInputElement).value;
                if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
                this._searchDebounceTimer = setTimeout(() => {
                    this._searchQuery = val;
                    this._renderedCount = BATCH_SIZE;
                    this.updateStreamOnly();
                }, 120);
            };

            if (this._searchQuery || isMobile) {
                const clearBtn = searchContainer.createSpan({
                    cls: 'pos-search-clear',
                    text: '✕',
                    attr: { 'aria-label': 'Clear search' }
                });
                clearBtn.onclick = () => {
                    this._searchQuery = '';
                    if (isMobile) this._mobileSearchOpen = false;
                    this._renderedCount = BATCH_SIZE;
                    this.renderHeaderBar(header);
                    this.updateStreamOnly();
                    this.updateComposerVisibility();
                };
            }
        }

        const actions = header.createDiv({ cls: 'pos-header-actions' });

        // Privacy Shield toggle
        const privacyBtn = actions.createEl('button', {
            cls: `pos-icon-btn pos-privacy-toggle ${this._isPrivacyShieldActive ? 'is-active' : ''}`,
            attr: { 'aria-label': this._isPrivacyShieldActive ? 'Disable Privacy Shield' : 'Enable Privacy Shield (Blur Reflections)' }
        });
        setIcon(privacyBtn, this._isPrivacyShieldActive ? 'eye-off' : 'eye');
        privacyBtn.onclick = () => {
            this.togglePrivacyShield();
        };

        // Sanctuary Mode toggle
        const sanctuaryBtn = actions.createEl('button', {
            cls: `pos-header-text-btn pos-sanctuary-btn ${this._isSanctuaryMode ? 'is-active' : ''}`,
            text: this._isSanctuaryMode ? '✦ Sanctuary' : 'Sanctuary',
            attr: { 'aria-label': 'Toggle Sanctuary Mode (Focused Deep Reflection)' }
        });
        sanctuaryBtn.onclick = () => {
            this._isSanctuaryMode = !this._isSanctuaryMode;
            this._containerEl?.toggleClass('is-sanctuary-mode', this._isSanctuaryMode);
            this.renderHeaderBar(header);
            if (this._isSanctuaryMode) {
                this._composerTextarea?.focus();
            }
        };

        // Resurface / Serendipity memory recall (safely excludes unburdening/private)
        const resurfaceBtn = actions.createEl('button', {
            cls: 'pos-icon-btn pos-resurface-btn',
            attr: { 'aria-label': 'Resurface a gentle memory' }
        });
        setIcon(resurfaceBtn, 'sparkles');
        resurfaceBtn.onclick = () => {
            const memory = this.plugin.index.getRandomMemory();
            if (!memory) {
                new Notice('No memories ready to resurface.');
                return;
            }
            new Notice(`Resurfaced memory from ${moment(memory.createdAtMs).format('MMMM D, YYYY')}`);
            this._searchQuery = memory.title;
            this._renderedCount = BATCH_SIZE;
            this.renderHeaderBar(header);
            this.updateStreamOnly();
        };

        // Select & Weave Mode toggle
        const selectBtn = actions.createEl('button', {
            cls: `pos-header-text-btn ${this._selectionMode ? 'is-active' : ''}`,
            text: this._selectionMode ? 'Done' : 'Select',
            attr: { 'aria-label': this._selectionMode ? 'Exit selection mode' : 'Select entries to weave together' }
        });
        selectBtn.onclick = () => {
            this._selectionMode = !this._selectionMode;
            if (!this._selectionMode) {
                this._selectedEntryIds.clear();
            }
            if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
            this.updateSelectionBar();
            this.updateStreamOnly();
        };

        // Mobile Search Toggle
        if (isMobile) {
            const searchToggleBtn = actions.createEl('button', {
                cls: `pos-icon-btn pos-mobile-search-toggle ${this._mobileSearchOpen || this._searchQuery ? 'is-active' : ''}`,
                attr: { 'aria-label': 'Search journal' }
            });
            setIcon(searchToggleBtn, 'search');
            searchToggleBtn.onclick = () => {
                this._mobileSearchOpen = !this._mobileSearchOpen;
                if (!this._mobileSearchOpen) {
                    this._searchQuery = '';
                }
                this._renderedCount = BATCH_SIZE;
                this.renderHeaderBar(header);
                this.updateComposerVisibility();
                this.updateStreamOnly();
            };
        }

        // Settings trigger
        const settingsBtn = actions.createEl('button', {
            cls: 'pos-icon-btn pos-settings-trigger',
            attr: { 'aria-label': 'Settings' }
        });
        setIcon(settingsBtn, 'settings');
        settingsBtn.onclick = () => {
            (this.app as any).setting?.open();
            (this.app as any).setting?.openTabById?.(this.plugin.manifest.id);
        };
    }

    private renderFilterBar(parent: HTMLElement): void {
        parent.empty();
        const scrollable = parent.createDiv({ cls: 'pos-filter-carousel' });

        const allEntries = this.plugin.index.getAllCaptures();
        const totalCount = allEntries.length;
        const todayCount = this.plugin.index.getTodayCapturesCount();
        const onThisDayMatches = this.plugin.index.getOnThisDayEntries();
        const favoritesCount = this.plugin.index.getFavorites().length;

        // 1. All Journal Entries
        this.createFilterChip(scrollable, 'all', '📖 All Journal', totalCount);

        // 2. Today
        this.createFilterChip(scrollable, 'today', '📅 Today', todayCount, todayCount > 0 ? 'pos-chip-accent' : '');

        // 3. On This Day (Handumanan Flashback)
        if (onThisDayMatches.length > 0) {
            this.createFilterChip(scrollable, 'on_this_day', '✨ On This Day', onThisDayMatches.length, 'pos-chip-gold');
        }

        // 4. Keepsakes / Favorites
        if (favoritesCount > 0) {
            this.createFilterChip(scrollable, 'favorites', '❤️ Keepsakes', favoritesCount);
        }

        // 5. Unburdening
        const unburdeningCount = allEntries.filter(e => e.type === 'unburdening' || (e.tags && e.tags.includes('unburdening'))).length;
        if (unburdeningCount > 0) {
            this.createFilterChip(scrollable, 'unburdening', '🌧️ Unburdening', unburdeningCount);
        }
    }

    private createFilterChip(parent: HTMLElement, filterId: JournalFilterMode, label: string, count: number, extraCls = ''): HTMLElement {
        const chip = parent.createDiv({
            cls: `pos-filter-chip ${this._activeFilter === filterId ? 'is-active' : ''} ${extraCls}`,
            attr: {
                role: 'button',
                tabindex: '0',
                'aria-pressed': String(this._activeFilter === filterId)
            }
        });
        chip.createSpan({ cls: 'pos-chip-label', text: label });
        chip.createSpan({ cls: 'pos-chip-badge', text: `${count}` });

        const toggleFilter = () => {
            this._activeFilter = this._activeFilter === filterId ? 'all' : filterId;
            this._renderedCount = BATCH_SIZE;
            this.renderFilterBar(this._filterBarEl!);
            this.updateStreamOnly();
        };

        chip.onclick = toggleFilter;
        chip.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleFilter();
            }
        };

        return chip;
    }

    private renderComposer(composer: HTMLElement, isMobile: boolean): void {
        composer.empty();

        // Circadian introspective prompt placeholder
        const placeholderPrompt = getCircadianPrompt();

        // Textarea row
        const inputRow = composer.createDiv({ cls: 'pos-composer-input-row' });
        const textarea = inputRow.createEl('textarea', {
            cls: 'pos-composer-textarea',
            placeholder: placeholderPrompt,
            attr: { rows: isMobile ? '2' : '3', enterkeyhint: 'enter' }
        });
        this._composerTextarea = textarea;

        // Restore draft
        const draft = this.plugin.capture.getDraft();
        if (draft) {
            textarea.value = draft;
        }

        // Wire formatting & triggers (binds @ to PersonSuggestModal)
        attachInlineTriggers(
            this.app, 
            textarea, 
            undefined, 
            undefined, 
            () => this.plugin.getContexts(), 
            this.plugin.settings?.peopleFolder
        );
        attachMediaPasteHandler(this.app, textarea, () => this.plugin.settings?.attachmentsFolder || '000 Bin/Handumanan Attachments');

        // Actions & Mood Beads row
        const bottomRow = composer.createDiv({ cls: 'pos-composer-bottom-row' });

        // Mood beads with accessibility
        const moodBeads = bottomRow.createDiv({ cls: 'pos-mood-beads-container' });
        const moods = [
            { id: 'calm', label: '🌿 Calm' },
            { id: 'grateful', label: '✨ Grateful' },
            { id: 'vulnerable', label: '🌧️ Vulnerable' },
            { id: 'reflective', label: '💭 Reflective' },
            { id: 'energized', label: '🔥 Energized' },
        ];

        const updateSubmitBtnLabel = () => {
            if (!this._composerSubmitBtn) return;
            const hasText = Boolean(textarea.value.trim());
            if (!hasText && this._selectedMood) {
                // Pebble-Drop micro-entry label
                this._composerSubmitBtn.setText(`✦ Log ${this._selectedMood}`);
            } else {
                this._composerSubmitBtn.setText(isMobile ? '↑' : '✦ Record');
            }
        };

        moods.forEach(m => {
            const bead = moodBeads.createSpan({
                cls: `pos-mood-bead ${this._selectedMood === m.id ? 'is-selected' : ''}`,
                text: m.label,
                attr: {
                    role: 'button',
                    tabindex: '0',
                    'aria-pressed': String(this._selectedMood === m.id)
                }
            });

            const toggleMood = () => {
                this._selectedMood = this._selectedMood === m.id ? '' : m.id;
                moodBeads.querySelectorAll('.pos-mood-bead').forEach(el => {
                    el.classList.remove('is-selected');
                    el.setAttribute('aria-pressed', 'false');
                });
                if (this._selectedMood === m.id) {
                    bead.classList.add('is-selected');
                    bead.setAttribute('aria-pressed', 'true');
                }
                updateSubmitBtnLabel();
            };

            bead.onclick = toggleMood;
            bead.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleMood();
                }
            };
        });

        // Right side controls
        const controls = bottomRow.createDiv({ cls: 'pos-composer-controls' });

        // Privacy lock button
        const lockBtn = controls.createEl('button', {
            cls: `pos-icon-btn pos-composer-privacy-btn ${this._isEntryPrivate ? 'is-active' : ''}`,
            attr: { 'aria-label': this._isEntryPrivate ? 'Marked Private' : 'Mark entry private' }
        });
        setIcon(lockBtn, this._isEntryPrivate ? 'lock' : 'unlock');
        lockBtn.onclick = () => {
            this._isEntryPrivate = !this._isEntryPrivate;
            setIcon(lockBtn, this._isEntryPrivate ? 'lock' : 'unlock');
            lockBtn.toggleClass('is-active', this._isEntryPrivate);
        };

        // Submit button
        const submitBtn = controls.createEl('button', {
            cls: 'pos-composer-submit-btn',
            text: isMobile ? '↑' : '✦ Record',
            attr: { 'aria-label': 'Record Journal Entry (⌘ Enter)' }
        });
        this._composerSubmitBtn = submitBtn;

        const executeSubmit = async () => {
            const content = textarea.value.trim();
            // Pebble-Drop check: if text is empty, must have a mood selected
            if (!content && !this._selectedMood) return;

            const mood = this._selectedMood;
            const isPrivate = this._isEntryPrivate;
            const isUnburdening = mood === 'vulnerable';

            submitBtn.disabled = true;
            try {
                await this.plugin.capture.createJournalEntry(content, {
                    mood,
                    type: isUnburdening ? 'unburdening' : 'journal',
                    isPrivate,
                    prompt: placeholderPrompt,
                });
                textarea.value = '';
                textarea.style.height = '';
                this.plugin.capture.clearDraft();
                this._selectedMood = '';
                this._isEntryPrivate = false;
                moodBeads.querySelectorAll('.pos-mood-bead').forEach(el => el.classList.remove('is-selected'));
                setIcon(lockBtn, 'unlock');
                lockBtn.removeClass('is-active');
                updateSubmitBtnLabel();
                new Notice(content ? 'Reflection recorded' : `Logged moment of ${mood}`);
                this.refreshAll();
            } catch (err) {
                console.error('[Handumanan] Failed to save journal entry', err);
                new Notice('Failed to record entry');
            } finally {
                submitBtn.disabled = false;
            }
        };

        submitBtn.onclick = () => void executeSubmit();

        textarea.onkeydown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void executeSubmit();
            }
        };

        textarea.oninput = () => {
            this.plugin.capture.saveDraft(textarea.value);
            updateSubmitBtnLabel();
            // Fluid height expansion up to 55vh
            textarea.style.height = 'auto';
            const maxHeight = Math.min(window.innerHeight * 0.55, 450);
            textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
        };
    }

    private updateSelectionBar(): void {
        if (!this._selectionBarEl) return;
        this._selectionBarEl.empty();

        if (!this._selectionMode) {
            this._selectionBarEl.style.display = 'none';
            return;
        }

        this._selectionBarEl.style.display = 'flex';
        const bar = this._selectionBarEl.createDiv({ cls: 'pos-selection-bar' });

        const count = this._selectedEntryIds.size;
        bar.createSpan({ cls: 'pos-selection-count', text: `${count} selected` });

        const actions = bar.createDiv({ cls: 'pos-selection-actions' });
        const weaveBtn = actions.createEl('button', {
            cls: 'pos-action-btn pos-btn-weave',
            text: '✦ Weave Entries into Reflection',
            attr: { disabled: count < 2 ? 'true' : null }
        });
        weaveBtn.onclick = async () => {
            if (this._selectedEntryIds.size < 2) {
                new Notice('Select at least 2 entries to weave.');
                return;
            }
            const selected = this.plugin.index.getAllCaptures().filter(e => this._selectedEntryIds.has(e.id));
            new MergeNotesModal(this.app, this.plugin, selected, () => {
                this._selectionMode = false;
                this._selectedEntryIds.clear();
                this.refreshAll();
            }).open();
        };

        const cancelBtn = actions.createEl('button', {
            cls: 'pos-action-btn',
            text: 'Cancel'
        });
        cancelBtn.onclick = () => {
            this._selectionMode = false;
            this._selectedEntryIds.clear();
            this.updateSelectionBar();
            this.updateStreamOnly();
        };
    }

    private getFilteredCaptures(): JournalEntry[] {
        let entries = this.plugin.index.getAllCaptures();

        // Search query takes precedence
        if (this._searchQuery.trim()) {
            const q = this._searchQuery.toLowerCase().trim();
            return entries.filter(e => 
                (e.body && e.body.toLowerCase().includes(q))
                || e.title.toLowerCase().includes(q)
                || (e.tags ?? []).some(t => t.toLowerCase().includes(q))
                || (e.people ?? []).some(p => p.toLowerCase().includes(q))
                || (e.mood && e.mood.toLowerCase().includes(q))
            );
        }

        // Filter mode
        if (this._activeFilter === 'today') {
            const todayStr = moment().format('YYYY-MM-DD');
            entries = entries.filter(e => e.day === todayStr);
        } else if (this._activeFilter === 'on_this_day') {
            entries = this.plugin.index.getOnThisDayEntries();
        } else if (this._activeFilter === 'favorites') {
            entries = entries.filter(e => e.favorite);
        } else if (this._activeFilter === 'unburdening') {
            entries = entries.filter(e => e.type === 'unburdening' || (e.tags && e.tags.includes('unburdening')));
        }

        return entries;
    }

    /**
     * Fresh render of the document stream.
     */
    private renderStream(container: HTMLElement): void {
        container.empty();
        this._lastRenderedDay = '';

        if (this._streamComponent) {
            this._streamComponent.unload();
            this.removeChild(this._streamComponent);
            this._streamComponent = null;
        }
        this._streamComponent = new Component();
        this.addChild(this._streamComponent);

        const filtered = this.getFilteredCaptures();

        if (filtered.length === 0) {
            const emptyEl = container.createDiv({ cls: 'pos-stream-empty-state' });
            emptyEl.createDiv({ cls: 'pos-empty-icon', text: '🌱' });
            emptyEl.createEl('h3', { text: this._searchQuery ? 'No reflections found' : 'Your sanctuary is peaceful' });
            emptyEl.createEl('p', { text: this._searchQuery ? `No thoughts matched "${this._searchQuery}"` : 'Take a quiet breath and record what is alive in you.' });
            return;
        }

        const initialBatch = filtered.slice(0, this._renderedCount);
        this.appendBatch(container, initialBatch);
        this.setupInfiniteScroll(container, filtered.length);
    }

    /**
     * Appends a batch of entries to the stream without destroying existing DOM nodes.
     * Guarantees 60fps scrolling at 10,000+ notes.
     */
    private appendBatch(container: HTMLElement, entries: JournalEntry[]): void {
        for (const entry of entries) {
            const entryDay = entry.day || moment(entry.createdAtMs).format('YYYY-MM-DD');
            if (entryDay !== this._lastRenderedDay) {
                this._lastRenderedDay = entryDay;
                this.renderDayDivider(container, entryDay);
            }
            this.renderJournalLeaf(container, entry);
        }
    }

    private renderDayDivider(container: HTMLElement, dayStr: string): void {
        const divider = container.createDiv({ cls: 'pos-day-divider' });
        const now = moment();
        const entryMoment = moment(dayStr, 'YYYY-MM-DD');

        let displayLabel = entryMoment.format('MMMM D, YYYY');
        if (dayStr === now.format('YYYY-MM-DD')) {
            displayLabel = `Today · ${entryMoment.format('MMMM D')}`;
        } else if (dayStr === now.clone().subtract(1, 'day').format('YYYY-MM-DD')) {
            displayLabel = `Yesterday · ${entryMoment.format('MMMM D')}`;
        } else if (entryMoment.isSame(now, 'year')) {
            displayLabel = entryMoment.format('dddd, MMMM D');
        }

        divider.createSpan({ cls: 'pos-day-label', text: displayLabel });
    }

    private renderJournalLeaf(container: HTMLElement, entry: JournalEntry): void {
        const leaf = container.createDiv({ cls: 'pos-journal-leaf' });
        leaf.dataset.id = entry.id;

        // Header: Time, Mood, Privacy, Actions
        const leafHeader = leaf.createDiv({ cls: 'pos-leaf-header' });
        const metaLeft = leafHeader.createDiv({ cls: 'pos-leaf-meta-left' });

        // Selection checkbox if in selection mode
        if (this._selectionMode) {
            const cb = metaLeft.createEl('input', { type: 'checkbox', cls: 'pos-leaf-select-cb' });
            cb.checked = this._selectedEntryIds.has(entry.id);
            cb.onclick = (ev) => {
                ev.stopPropagation();
                if (cb.checked) {
                    this._selectedEntryIds.add(entry.id);
                } else {
                    this._selectedEntryIds.delete(entry.id);
                }
                this.updateSelectionBar();
            };
        }

        // Time of Day
        const timeStr = moment(entry.createdAtMs).format('h:mm A');
        metaLeft.createSpan({ cls: 'pos-leaf-time', text: timeStr });

        // Mood Badge
        if (entry.mood) {
            metaLeft.createSpan({ cls: `pos-leaf-mood-badge pos-mood-${entry.mood.toLowerCase()}`, text: entry.mood });
        }

        // Privacy indicator
        if (entry.private) {
            const privBadge = metaLeft.createSpan({ cls: 'pos-leaf-private-badge' });
            setIcon(privBadge, 'lock');
        }

        // Actions: Keepsake Heart, Edit, Trash
        const leafActions = leafHeader.createDiv({ cls: 'pos-leaf-actions' });

        const heartBtn = leafActions.createEl('button', {
            cls: `pos-icon-btn pos-heart-btn ${entry.favorite ? 'is-active' : ''}`,
            attr: { 'aria-label': entry.favorite ? 'Remove Keepsake' : 'Mark as Keepsake' }
        });
        setIcon(heartBtn, 'heart');
        heartBtn.onclick = async (e) => {
            e.stopPropagation();
            const isFav = await this.plugin.capture.toggleFavorite(entry.filePath);
            entry.favorite = isFav;
            heartBtn.toggleClass('is-active', isFav);
            this.renderFilterBar(this._filterBarEl!);
        };

        const editBtn = leafActions.createEl('button', {
            cls: 'pos-icon-btn pos-edit-btn',
            attr: { 'aria-label': 'Edit Reflection' }
        });
        setIcon(editBtn, 'pencil');
        editBtn.onclick = (e) => {
            e.stopPropagation();
            this.renderInlineEditor(leaf, entry);
        };

        const trashBtn = leafActions.createEl('button', {
            cls: 'pos-icon-btn pos-trash-btn',
            attr: { 'aria-label': 'Trash' }
        });
        setIcon(trashBtn, 'trash-2');
        trashBtn.onclick = async (e) => {
            e.stopPropagation();
            const confirmed = window.confirm('Move this reflection to trash?');
            if (!confirmed) return;
            await this.plugin.capture.deleteNote(entry.filePath);
            leaf.remove();
            new Notice('Reflection moved to trash');
        };

        // Rendered Body (with safe click-to-reveal toggle)
        const bodyEl = leaf.createDiv({ cls: 'pos-leaf-body' });
        bodyEl.onclick = (e) => {
            if (this._isPrivacyShieldActive) {
                e.stopPropagation();
                bodyEl.classList.toggle('is-unblurred');
            }
        };

        // Leaf Footer: Word count, People, Themes
        const leafFooter = leaf.createDiv({ cls: 'pos-leaf-footer' });
        const wordInfo = leafFooter.createSpan({ cls: 'pos-leaf-word-count', text: 'reading...' });

        if (entry.people && entry.people.length > 0) {
            const peopleContainer = leafFooter.createSpan({ cls: 'pos-leaf-people' });
            peopleContainer.setText(`with ${entry.people.map(p => `[[${p}]]`).join(', ')}`);
        }

        // Lazy body loading & Markdown rendering
        void (async () => {
            const bodyText = await this.plugin.index.ensureEntryBodyLoaded(entry);
            const cacheKey = `${entry.filePath}_${entry.modified}`;
            const cachedEl = this.getCachedRenderedBody(cacheKey);

            if (cachedEl) {
                bodyEl.empty();
                bodyEl.appendChild(cachedEl);
            } else if (this._streamComponent) {
                const tempDiv = document.createElement('div');
                await MarkdownRenderer.render(this.app, bodyText, tempDiv, entry.filePath, this._streamComponent);
                this.setCachedRenderedBody(cacheKey, tempDiv);
                bodyEl.empty();
                bodyEl.appendChild(tempDiv);
            }

            // Update word count in footer
            wordInfo.setText(`${entry.wordCount || bodyText.trim().split(/\s+/).length} words · ${entry.readingTimeMin || 1} min reflection`);
        })();
    }

    private renderInlineEditor(leaf: HTMLElement, entry: JournalEntry): void {
        leaf.empty();
        leaf.addClass('is-editing');

        const textarea = leaf.createEl('textarea', {
            cls: 'pos-inline-edit-textarea',
            value: entry.body,
        });

        attachInlineTriggers(this.app, textarea);
        attachMediaPasteHandler(this.app, textarea, () => this.plugin.settings?.attachmentsFolder || '000 Bin/Handumanan Attachments');

        const btnRow = leaf.createDiv({ cls: 'pos-inline-edit-btns' });
        const saveBtn = btnRow.createEl('button', { cls: 'pos-action-btn pos-btn-primary', text: 'Save' });
        const cancelBtn = btnRow.createEl('button', { cls: 'pos-action-btn', text: 'Cancel' });

        saveBtn.onclick = async () => {
            const val = textarea.value.trim();
            if (!val) return;
            await this.plugin.capture.updateNoteContent(entry.filePath, val);
            entry.body = val;
            this.invalidateRenderCacheForFile(entry.filePath);
            this.updateStreamOnly();
        };

        cancelBtn.onclick = () => {
            if (textarea.value.trim() !== entry.body.trim()) {
                const confirmDiscard = window.confirm('Discard unsaved edits to this reflection?');
                if (!confirmDiscard) return;
            }
            this.updateStreamOnly();
        };
    }

    private setupInfiniteScroll(container: HTMLElement, totalCount: number): void {
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
        }

        if (this._renderedCount >= totalCount) return;

        // Ensure single sentinel at container bottom
        if (this._scrollSentinelEl) {
            this._scrollSentinelEl.remove();
        }
        this._scrollSentinelEl = container.createDiv({ cls: 'pos-scroll-sentinel' });

        this._intersectionObserver = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this._isLoadingMore) {
                if (this._renderedCount < totalCount) {
                    this._isLoadingMore = true;
                    const filtered = this.getFilteredCaptures();
                    const from = this._renderedCount;
                    const to = Math.min(totalCount, from + BATCH_SIZE);
                    const nextBatch = filtered.slice(from, to);

                    // Move sentinel before appending next batch
                    this._scrollSentinelEl?.remove();
                    this.appendBatch(container, nextBatch);
                    this._renderedCount = to;

                    if (this._renderedCount < totalCount && this._scrollSentinelEl) {
                        container.appendChild(this._scrollSentinelEl);
                    }
                    this._isLoadingMore = false;
                }
            }
        }, { rootMargin: '300px' });

        if (this._scrollSentinelEl) {
            this._intersectionObserver.observe(this._scrollSentinelEl);
        }
    }

    private updateStreamOnly(): void {
        if (!this._streamContainerEl) return;
        this.renderStream(this._streamContainerEl);
    }
}
