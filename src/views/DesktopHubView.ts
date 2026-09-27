import { ItemView, WorkspaceLeaf, TFile, MarkdownRenderer, moment, Notice, Platform, Menu, Component, setIcon } from 'obsidian';
import type HandumananPlugin from '../main';
import { 
    VIEW_TYPE_DESKTOP_HUB, 
    DESKTOP_HUB_ICON_ID, 
    INTROSPECTIVE_PROMPTS,
} from '../constants';
import { JournalEntry, JournalFilterMode, JournalType } from '../types';
import { MergeNotesModal } from '../modals/MergeNotesModal';
import { JournalEditConflictError } from '../services/CaptureService';
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
    private _recalledEntryId: string | null = null;
    private _mobileSearchOpen: boolean = false;
    private _viewportCleanup: (() => void) | null = null;

    // Journal Modes
    private _isPrivacyShieldActive: boolean = false;
    private _isSanctuaryMode: boolean = false;
    private _selectedMood: string = '';
    private _isEntryPrivate: boolean = false;
    _capturePending: number = 0;
    _taskPending: number = 0;

    // Bounded stream pagination, component lifecycle & LRU caching
    private _pageStart: number = 0;
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
        if (this._streamContainerEl && !this._editingEntryId) this.updateStreamOnly();
    }

    togglePrivacyShield(): void {
        const restoreHeaderFocus = Boolean(this._headerBarEl?.contains(document.activeElement));
        this._isPrivacyShieldActive = !this._isPrivacyShieldActive;
        this._containerEl?.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);
        this._containerEl?.querySelectorAll<HTMLElement>('.pos-journal-leaf').forEach(leaf => {
            const body = leaf.querySelector<HTMLElement>('.pos-leaf-body');
            const reveal = leaf.querySelector<HTMLButtonElement>('.pos-leaf-reveal-btn');
            body?.removeClass('is-unblurred');
            if (body) body.inert = this._isPrivacyShieldActive;
            if (reveal) {
                reveal.setAttribute('aria-pressed', 'false');
                reveal.setAttribute('aria-label', 'Reveal this reflection');
                setIcon(reveal, 'eye');
            }
        });
        if (this._headerBarEl) {
            this.renderHeaderBar(this._headerBarEl);
            if (restoreHeaderFocus) {
                this._headerBarEl.querySelector<HTMLButtonElement>('.pos-privacy-toggle')?.focus({ preventScroll: true });
            }
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
            this._pageStart = 0;
        }

        this._containerEl.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);
        this._containerEl.toggleClass('is-sanctuary-mode', this._isSanctuaryMode);

        const isMobile = Platform.isMobile && !isTablet(this.app);
        this._containerEl.toggleClass('is-phone-layout', isMobile);

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
                clearBtn.disabled = !val && !isMobile;
                if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
                this._searchDebounceTimer = setTimeout(() => {
                    this._searchQuery = val;
                    this._recalledEntryId = null;
                    this._pageStart = 0;
                    this.updateStreamOnly();
                }, 120);
            };

            const clearBtn = searchContainer.createEl('button', {
                cls: 'pos-search-clear',
                text: '✕',
                attr: { type: 'button', 'aria-label': isMobile ? 'Clear search and close search' : 'Clear search' }
            });
            clearBtn.disabled = !this._searchQuery && !isMobile;
            clearBtn.onclick = () => {
                if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
                this._searchDebounceTimer = null;
                this._searchQuery = '';
                this._recalledEntryId = null;
                if (isMobile) this._mobileSearchOpen = false;
                this._pageStart = 0;
                this.renderHeaderBar(header);
                this.updateStreamOnly();
                this.updateComposerVisibility();
                if (!isMobile) header.querySelector<HTMLInputElement>('.pos-search-input')?.focus();
            };
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

        const toggleSanctuary = () => {
            this._isSanctuaryMode = !this._isSanctuaryMode;
            this._containerEl?.toggleClass('is-sanctuary-mode', this._isSanctuaryMode);
            this.renderHeaderBar(header);
            if (this._isSanctuaryMode) {
                this._composerTextarea?.focus();
            } else {
                header.querySelector<HTMLButtonElement>(isMobile ? '.pos-more-toggle' : '.pos-sanctuary-btn')?.focus({ preventScroll: true });
            }
        };

        // Recall is user-initiated; selection remains in IndexService.
        const recallReflection = () => {
            const memory = this.plugin.index.getRandomMemory();
            if (!memory || memory.private || memory.type === 'unburdening' || memory.tags?.includes('unburdening')) {
                new Notice('No reflections eligible for recall yet. Private and unburdening entries stay out of recall.');
                return;
            }
            if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
            this._searchDebounceTimer = null;
            this._searchQuery = '';
            this._activeFilter = 'all';
            this._recalledEntryId = memory.id;
            this._pageStart = 0;
            this.renderHeaderBar(header);
            if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
            this.updateStreamOnly();
            this.updateComposerVisibility();
            this._streamContainerEl?.querySelector<HTMLButtonElement>('.pos-recall-banner button')?.focus({ preventScroll: true });
        };

        // Select & Weave Mode toggle
        const toggleSelection = () => {
            this._selectionMode = !this._selectionMode;
            if (!this._selectionMode) {
                this._selectedEntryIds.clear();
            }
            if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
            this.updateSelectionBar();
            this.updateStreamOnly();
            header.querySelector<HTMLButtonElement>(isMobile ? '.pos-more-toggle' : '.pos-select-btn')?.focus({ preventScroll: true });
        };

        if (!isMobile) {
            const sanctuaryBtn = actions.createEl('button', {
                cls: `pos-header-text-btn pos-sanctuary-btn ${this._isSanctuaryMode ? 'is-active' : ''}`,
                text: this._isSanctuaryMode ? '✦ Sanctuary' : 'Sanctuary',
                attr: { 'aria-label': 'Toggle Sanctuary Mode (Focused Deep Reflection)' }
            });
            sanctuaryBtn.onclick = toggleSanctuary;

            const resurfaceBtn = actions.createEl('button', {
                cls: 'pos-header-text-btn pos-resurface-btn',
                text: '✦ Recall',
                attr: { 'aria-label': 'Recall a reflection now (excludes private and unburdening entries)', title: 'May revisit On This Day, keepsakes, or older reflections. Private and unburdening entries are excluded.' }
            });
            resurfaceBtn.onclick = recallReflection;

            const selectBtn = actions.createEl('button', {
                cls: `pos-header-text-btn pos-select-btn ${this._selectionMode ? 'is-active' : ''}`,
                text: this._selectionMode ? 'Done' : 'Select',
                attr: { 'aria-label': this._selectionMode ? 'Exit selection mode' : 'Select entries to weave together' }
            });
            selectBtn.onclick = toggleSelection;
        }

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
                this._recalledEntryId = null;
                this._pageStart = 0;
                this.renderHeaderBar(header);
                this.updateComposerVisibility();
                this.updateStreamOnly();
                if (this._mobileSearchOpen) {
                    header.querySelector<HTMLInputElement>('.pos-search-input')?.focus();
                } else {
                    header.querySelector<HTMLButtonElement>('.pos-mobile-search-toggle')?.focus({ preventScroll: true });
                }
            };
        }

        const openSettings = () => {
            (this.app as any).setting?.open();
            (this.app as any).setting?.openTabById?.(this.plugin.manifest.id);
        };
        if (isMobile) {
            const moreBtn = actions.createEl('button', {
                cls: 'pos-icon-btn pos-more-toggle',
                attr: { type: 'button', 'aria-label': 'More journal actions', 'aria-haspopup': 'menu' }
            });
            setIcon(moreBtn, 'ellipsis');
            moreBtn.onclick = () => {
                const menu = new Menu();
                menu.addItem(item => item.setTitle(this._isSanctuaryMode ? 'Exit Sanctuary' : 'Enter Sanctuary')
                    .setIcon('sparkles').onClick(toggleSanctuary));
                menu.addItem(item => item.setTitle('Recall a reflection')
                    .setIcon('history').onClick(recallReflection));
                menu.addItem(item => item.setTitle(this._selectionMode ? 'Done selecting' : 'Select entries')
                    .setIcon('list-checks').onClick(toggleSelection));
                menu.addSeparator();
                menu.addItem(item => item.setTitle('Settings').setIcon('settings').onClick(openSettings));
                const bounds = moreBtn.getBoundingClientRect();
                menu.showAtPosition({ x: bounds.right, y: bounds.bottom });
            };
        } else {
            const settingsBtn = actions.createEl('button', {
                cls: 'pos-icon-btn pos-settings-trigger',
                attr: { 'aria-label': 'Settings' }
            });
            setIcon(settingsBtn, 'settings');
            settingsBtn.onclick = openSettings;
        }
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
        this.createFilterChip(scrollable, 'favorites', '❤️ Keepsakes', favoritesCount);

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
                'data-filter': filterId,
                'aria-pressed': String(this._activeFilter === filterId)
            }
        });
        chip.createSpan({ cls: 'pos-chip-label', text: label });
        chip.createSpan({ cls: 'pos-chip-badge', text: `${count}` });

        const toggleFilter = (restoreFocus = false) => {
            this._activeFilter = this._activeFilter === filterId ? 'all' : filterId;
            this._recalledEntryId = null;
            this._pageStart = 0;
            this.renderFilterBar(this._filterBarEl!);
            this.updateStreamOnly();
            if (restoreFocus) {
                this._filterBarEl?.querySelector<HTMLElement>(`.pos-filter-chip[data-filter="${filterId}"]`)?.focus();
            }
        };

        chip.onclick = () => toggleFilter();
        chip.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleFilter(true);
            }
        };

        return chip;
    }

    private renderComposer(composer: HTMLElement, isMobile: boolean): void {
        composer.empty();

        // Circadian introspective prompt placeholder
        const placeholderPrompt = getCircadianPrompt();

        // Textarea row
        const mainRow = isMobile ? composer.createDiv({ cls: 'pos-mobile-composer-main-row' }) : composer;
        const inputRow = mainRow.createDiv({ cls: isMobile ? 'pos-composer-input-row pos-composer-input-pill' : 'pos-composer-input-row' });
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
        const bottomRow = composer.createDiv({ cls: isMobile ? 'pos-composer-bottom-row pos-mobile-composer-pills-row' : 'pos-composer-bottom-row' });

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
            if (isMobile) {
                this._composerSubmitBtn.setText('↑');
                this._composerSubmitBtn.setAttribute('aria-label', !hasText && this._selectedMood
                    ? `Log ${this._selectedMood} mood`
                    : 'Record journal entry');
            } else if (!hasText && this._selectedMood) {
                // Pebble-Drop micro-entry label
                this._composerSubmitBtn.setText(`✦ Log ${this._selectedMood}`);
            } else {
                this._composerSubmitBtn.setText(isMobile ? '↑' : '✦ Record');
            }
        };

        moods.forEach(m => {
            const bead = moodBeads.createEl('button', {
                cls: `pos-mood-bead ${this._selectedMood === m.id ? 'is-selected' : ''}`,
                text: m.label,
                attr: {
                    type: 'button',
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
        });

        // Right side controls
        const controls = (isMobile ? mainRow : bottomRow).createDiv({ cls: 'pos-composer-controls' });

        // Privacy lock button
        const lockBtn = (isMobile ? bottomRow : controls).createEl('button', {
            cls: `pos-icon-btn pos-composer-privacy-btn ${this._isEntryPrivate ? 'is-active' : ''}`,
            attr: { 'aria-label': this._isEntryPrivate ? 'Entry private (excluded from recall)' : 'Mark entry private (excluded from recall)', 'aria-pressed': String(this._isEntryPrivate) }
        });
        setIcon(lockBtn, this._isEntryPrivate ? 'lock' : 'unlock');
        lockBtn.onclick = () => {
            this._isEntryPrivate = !this._isEntryPrivate;
            setIcon(lockBtn, this._isEntryPrivate ? 'lock' : 'unlock');
            lockBtn.toggleClass('is-active', this._isEntryPrivate);
            lockBtn.setAttribute('aria-pressed', String(this._isEntryPrivate));
            lockBtn.setAttribute('aria-label', this._isEntryPrivate ? 'Entry private (excluded from recall)' : 'Mark entry private (excluded from recall)');
        };

        // Submit button
        const submitBtn = controls.createEl('button', {
            cls: `pos-composer-submit-btn ${isMobile ? 'pos-composer-send-btn-circle' : ''}`,
            text: isMobile ? '↑' : '✦ Record',
            attr: { 'aria-label': isMobile ? 'Record journal entry' : 'Record Journal Entry (⌘ Enter)' }
        });
        this._composerSubmitBtn = submitBtn;
        updateSubmitBtnLabel();

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
                moodBeads.querySelectorAll('.pos-mood-bead').forEach(el => {
                    el.classList.remove('is-selected');
                    el.setAttribute('aria-pressed', 'false');
                });
                setIcon(lockBtn, 'unlock');
                lockBtn.removeClass('is-active');
                lockBtn.setAttribute('aria-pressed', 'false');
                lockBtn.setAttribute('aria-label', 'Mark entry private (excluded from recall)');
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

        if (this._recalledEntryId) {
            return entries.filter(e => e.id === this._recalledEntryId && !e.private && e.type !== 'unburdening' && !e.tags?.includes('unburdening'));
        }

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
    private renderStream(container: HTMLElement, preservePosition = true): void {
        const firstVisible = Array.from(container.querySelectorAll<HTMLElement>('.pos-journal-leaf'))
            .find(leaf => leaf.getBoundingClientRect().bottom > this.contentEl.getBoundingClientRect().top);
        const anchorId = preservePosition ? firstVisible?.dataset.id : undefined;
        const anchorTop = firstVisible?.getBoundingClientRect().top;
        const focused = document.activeElement as HTMLElement;
        const focusedLeaf = container.contains(focused) ? focused.closest<HTMLElement>('.pos-journal-leaf') : null;
        const focusedAction = ['pos-heart-btn', 'pos-edit-btn', 'pos-trash-btn', 'pos-leaf-reveal-btn']
            .find(cls => focused.classList.contains(cls));
        const focusedPageButton = container.contains(focused) && focused.classList.contains('pos-stream-page-btn')
            ? focused.textContent : null;
        const focusedPageStatus = container.contains(focused) && focused.classList.contains('pos-stream-page-status');
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

        if (this._recalledEntryId) {
            const recall = container.createDiv({ cls: 'pos-recall-banner' });
            recall.createSpan({ text: filtered.length
                ? 'A reflection to revisit · Recall runs only when you choose it. It may surface On This Day, a keepsake, or an older entry; private and unburdening entries stay out.'
                : 'This reflection is no longer available for recall.' });
            const showAll = recall.createEl('button', { cls: 'pos-action-btn', text: 'Back to journal' });
            showAll.onclick = () => {
                this._recalledEntryId = null;
                this.updateStreamOnly();
            };
        }

        if (filtered.length === 0) {
            this._pageStart = 0;
            const emptyEl = container.createDiv({ cls: 'pos-stream-empty-state' });
            emptyEl.createDiv({ cls: 'pos-empty-icon', text: '🌱' });
            const firstEntry = !this._searchQuery && !this._recalledEntryId && this.plugin.index.getAllCaptures().length === 0;
            emptyEl.createEl('h3', { text: firstEntry ? 'Begin with one reflection' : this._searchQuery ? 'No reflections found' : 'Your sanctuary is peaceful' });
            emptyEl.createEl('p', { text: firstEntry ? 'Write a thought above, or choose a mood to capture a moment. Your unfinished writing stays as a local draft; use Ctrl/⌘ + Enter to record it.' : this._searchQuery ? `No thoughts matched "${this._searchQuery}"` : this._activeFilter === 'favorites' ? 'Mark a reflection with the heart to keep it here. Keepsakes do not override recall privacy exclusions.' : 'Take a quiet breath and record what is alive in you.' });
            if (firstEntry) emptyEl.createEl('p', { text: 'Use the lock to mark an entry private. Private and unburdening entries are never chosen by Recall.' });
            return;
        }

        this._pageStart = Math.min(this._pageStart, Math.floor((filtered.length - 1) / BATCH_SIZE) * BATCH_SIZE);
        const pageEnd = Math.min(filtered.length, this._pageStart + BATCH_SIZE);
        const pageLabel = `Reflections ${this._pageStart + 1}–${pageEnd} of ${filtered.length}`;
        const header = container.createDiv({ cls: 'pos-stream-page-nav' });
        const pageStatus = header.createSpan({ cls: 'pos-stream-page-status', text: pageLabel, attr: { tabindex: '-1' } });
        if (this._pageStart > 0) this.createPageButton(header, 'Newer reflections', this._pageStart - BATCH_SIZE);
        this.appendBatch(container, filtered.slice(this._pageStart, pageEnd));
        if (pageEnd < filtered.length) {
            const footer = container.createDiv({ cls: 'pos-stream-page-nav pos-stream-page-footer' });
            footer.createSpan({ cls: 'pos-stream-page-status', text: pageLabel });
            this.createPageButton(footer, 'Older reflections', pageEnd);
        }

        if (anchorId !== undefined && anchorTop !== undefined) {
            const anchor = Array.from(container.querySelectorAll<HTMLElement>('.pos-journal-leaf'))
                .find(leaf => leaf.dataset.id === anchorId);
            if (anchor) this.contentEl.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
        }
        if (focusedLeaf && focusedAction) {
            const replacement = Array.from(container.querySelectorAll<HTMLElement>('.pos-journal-leaf'))
                .find(leaf => leaf.dataset.id === focusedLeaf.dataset.id);
            replacement?.querySelector<HTMLElement>(`.${focusedAction}`)?.focus({ preventScroll: true });
        }
        if (preservePosition && (focusedPageButton || focusedPageStatus)) {
            const replacement = Array.from(container.querySelectorAll<HTMLButtonElement>('.pos-stream-page-btn'))
                .find(button => button.textContent === focusedPageButton);
            (replacement ?? pageStatus).focus({ preventScroll: true });
        }
        if (!preservePosition) {
            pageStatus.focus({ preventScroll: true });
            pageStatus.scrollIntoView({ block: 'start' });
        }
    }

    /**
     * Renders only the entries on the current page.
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

    private createPageButton(parent: HTMLElement, label: string, start: number): void {
        const button = parent.createEl('button', { cls: 'pos-action-btn pos-stream-page-btn', text: label });
        button.onclick = () => {
            this._pageStart = start;
            if (this._streamContainerEl) this.renderStream(this._streamContainerEl, false);
        };
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
            attr: { 'aria-label': entry.favorite ? 'Remove Keepsake' : 'Mark as Keepsake', 'aria-pressed': String(Boolean(entry.favorite)), title: 'Keepsakes are for your own browsing; private and unburdening entries remain excluded from recall' }
        });
        setIcon(heartBtn, 'heart');
        heartBtn.onclick = async (e) => {
            e.stopPropagation();
            heartBtn.disabled = true;
            try {
                const isFav = await this.plugin.capture.toggleFavorite(entry.filePath);
                entry.favorite = isFav;
                heartBtn.toggleClass('is-active', isFav);
                heartBtn.setAttribute('aria-pressed', String(isFav));
                if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
            } catch (err) {
                console.error('[Handumanan] Could not change keepsake', err);
                new Notice('Could not update this keepsake. Please retry.');
            } finally {
                heartBtn.disabled = false;
            }
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
            trashBtn.disabled = true;
            try {
                await this.plugin.capture.deleteNote(entry.filePath);
                leaf.remove();
                new Notice('Reflection moved to trash');
            } catch (err) {
                console.error('[Handumanan] Could not trash reflection', err);
                new Notice('Could not move this reflection to trash. Please retry.');
            } finally {
                trashBtn.disabled = false;
            }
        };

        // Explicit per-entry reveal leaves Markdown links and selection untouched.
        const revealBtn = leafActions.createEl('button', {
            cls: 'pos-icon-btn pos-leaf-reveal-btn',
            attr: { 'aria-label': 'Reveal this reflection', 'aria-pressed': 'false', title: 'Reveal this reflection while Privacy Shield is on' }
        });
        setIcon(revealBtn, 'eye');
        const bodyEl = leaf.createDiv({ cls: 'pos-leaf-body' });
        bodyEl.inert = this._isPrivacyShieldActive;
        revealBtn.onclick = () => {
            const revealed = bodyEl.classList.toggle('is-unblurred');
            bodyEl.inert = this._isPrivacyShieldActive && !revealed;
            revealBtn.setAttribute('aria-pressed', String(revealed));
            revealBtn.setAttribute('aria-label', revealed ? 'Hide this reflection' : 'Reveal this reflection');
            setIcon(revealBtn, revealed ? 'eye-off' : 'eye');
        };

        // Leaf Footer: Word count, People, Themes
        const leafFooter = leaf.createDiv({ cls: 'pos-leaf-footer' });
        const wordInfo = leafFooter.createSpan({ cls: 'pos-leaf-word-count', text: 'reading...' });

        if (entry.people && entry.people.length > 0) {
            const peopleContainer = leafFooter.createSpan({ cls: 'pos-leaf-people' });
            peopleContainer.setText(`with ${entry.people.map(p => `[[${p}]]`).join(', ')}`);
        }

        // Lazy body loading & Markdown rendering
        const renderComponent = this._streamComponent;
        void (async () => {
            try {
                const bodyText = await this.plugin.index.ensureEntryBodyLoaded(entry);
                if (!bodyEl.isConnected || renderComponent !== this._streamComponent) return;
                const cacheKey = `${entry.filePath}_${entry.modified}`;
                const cachedEl = this.getCachedRenderedBody(cacheKey);

                if (cachedEl) {
                    bodyEl.empty();
                    bodyEl.appendChild(cachedEl);
                } else if (renderComponent) {
                    const tempDiv = document.createElement('div');
                    await MarkdownRenderer.render(this.app, bodyText, tempDiv, entry.filePath, renderComponent);
                    if (!bodyEl.isConnected || renderComponent !== this._streamComponent) return;
                    this.setCachedRenderedBody(cacheKey, tempDiv);
                    bodyEl.empty();
                    bodyEl.appendChild(tempDiv);
                }

                wordInfo.setText(`${entry.wordCount || bodyText.trim().split(/\s+/).length} words · ${entry.readingTimeMin || 1} min reflection`);
            } catch (err) {
                console.error('[Handumanan] Could not render reflection', entry.filePath, err);
                if (bodyEl.isConnected) bodyEl.setText('Could not display this reflection. Open the Markdown file to read it.');
            }
        })();
    }

    private async renderInlineEditor(leaf: HTMLElement, entry: JournalEntry): Promise<void> {
        if (this._editingEntryId) return;
        this._editingEntryId = entry.id;
        let originalBody: string;
        try {
            if (!entry.body) await this.plugin.index.ensureEntryBodyLoaded(entry);
            const file = this.app.vault.getAbstractFileByPath(entry.filePath);
            if (!(file instanceof TFile)) throw new Error(`Reflection not found: ${entry.filePath}`);
            const raw = await this.app.vault.read(file);
            const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
            originalBody = (frontmatter ? raw.slice(frontmatter[0].length) : raw).trim();
            if (!leaf.isConnected || this._editingEntryId !== entry.id) {
                if (this._editingEntryId === entry.id) this._editingEntryId = null;
                return;
            }
            if (entry.body !== originalBody) {
                this.invalidateRenderCacheForFile(entry.filePath);
                entry.body = originalBody;
            }
        } catch (err) {
            this._editingEntryId = null;
            console.error('[Handumanan] Failed to load reflection for editing', err);
            new Notice('Could not load this reflection for editing. Please reopen it and try again.');
            return;
        }
        leaf.empty();
        leaf.addClass('is-editing');

        const textarea = leaf.createEl('textarea', {
            cls: 'pos-inline-edit-textarea',
            value: originalBody,
        });
        textarea.focus();

        attachInlineTriggers(this.app, textarea);
        attachMediaPasteHandler(this.app, textarea, () => this.plugin.settings?.attachmentsFolder || '000 Bin/Handumanan Attachments');

        const btnRow = leaf.createDiv({ cls: 'pos-inline-edit-btns' });
        const saveBtn = btnRow.createEl('button', { cls: 'pos-action-btn pos-btn-primary', text: 'Save' });
        const cancelBtn = btnRow.createEl('button', { cls: 'pos-action-btn', text: 'Cancel' });
        const errorEl = leaf.createDiv({ cls: 'pos-inline-edit-error', attr: { role: 'alert' } });
        let saving = false;

        saveBtn.onclick = async () => {
            if (saving) return;
            const val = textarea.value.trim();
            if (!val) {
                errorEl.setText('Write a reflection before saving, or cancel to leave it unchanged.');
                return;
            }
            saving = true;
            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            errorEl.empty();
            try {
                await this.plugin.capture.updateNoteContent(entry.filePath, val, undefined, undefined, originalBody);
                entry.body = val;
                this.invalidateRenderCacheForFile(entry.filePath);
                this._editingEntryId = null;
                this.updateStreamOnly();
            } catch (err) {
                console.error('[Handumanan] Failed to save reflection edit', err);
                const guidance = err instanceof JournalEditConflictError
                    ? 'This reflection changed elsewhere. Your edit is still here. Copy it, cancel editing, then reopen the reflection to review changes before applying your edits.'
                    : 'Could not save. Your edit is still here. Check the note or connection, then retry; copy your text before leaving.';
                errorEl.setText(guidance);
                new Notice(guidance, 8000);
            } finally {
                saving = false;
                saveBtn.disabled = false;
                cancelBtn.disabled = false;
            }
        };

        cancelBtn.onclick = () => {
            if (saving) return;
            if (textarea.value.trim() !== originalBody.trim()) {
                const confirmDiscard = window.confirm('Discard unsaved edits to this reflection?');
                if (!confirmDiscard) return;
            }
            this._editingEntryId = null;
            this.updateStreamOnly();
        };
    }

    private updateStreamOnly(): void {
        if (!this._streamContainerEl) return;
        this.renderStream(this._streamContainerEl);
    }
}
