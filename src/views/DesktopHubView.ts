import { ItemView, WorkspaceLeaf, TFile, MarkdownRenderer, moment, Notice, Platform, Menu, Component, setIcon } from 'obsidian';
import type HandumananPlugin from '../main';
import { 
    VIEW_TYPE_DESKTOP_HUB, 
    DESKTOP_HUB_ICON_ID, 
    ICON_PANEL_BOTTOM_SHOW_ID,
    ICON_PANEL_BOTTOM_HIDE_ID,
} from '../constants';
import { JournalEntry, JournalFilterMode, ScratchpadFilterMode, CaptureEntry } from '../types';
import { MergeNotesModal } from '../modals/MergeNotesModal';
import { ImageLightboxModal } from '../modals/ImageLightboxModal';
import { isTablet, attachInlineTriggers, attachMediaPasteHandler } from '../utils';
import { attachMobileSheetViewportBehavior } from '../utils/mobileSheetViewport';

const BATCH_SIZE = 25;

export class DesktopHubView extends ItemView {
    plugin: HandumananPlugin;
    private _containerEl: HTMLElement | null = null;
    private _streamContainerEl: HTMLElement | null = null;
    private _filterBarEl: HTMLElement | null = null;
    private _selectionBarEl: HTMLElement | null = null;
    private _headerBarEl: HTMLElement | null = null;
    private _composerSlotEl: HTMLElement | null = null;
    private _composerEl: HTMLElement | null = null;
    private _composerTextarea: HTMLTextAreaElement | null = null;
    private _composerSubmitBtn: HTMLButtonElement | null = null;

    private _activeFilter: ScratchpadFilterMode = 'all';
    private _filterTasksOnly: boolean = false;
    private _searchQuery: string = '';
    private _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private _selectedAreaForNewNote: string = '';
    private _selectedImportantForNewNote: boolean = false;
    private _selectedEntryIds: Set<string> = new Set();
    private _selectionMode: boolean = false;
    private _editingEntryId: string | null = null;
    private _mobileSearchOpen: boolean = false;
    private _searchOpen: boolean = false;
    private _mobileComposerOpen: boolean = false;
    private _desktopComposerExpanded: boolean = false;
    private _viewportCleanup: (() => void) | null = null;

    // Privacy & Sanctuary Modes
    private _isPrivacyShieldActive: boolean = false;
    private _isSanctuaryMode: boolean = false;
    private _isEntryPrivate: boolean = false;
    private _isNavbarHidden: boolean = true;
    _capturePending: number = 0;
    _taskPending: number = 0;

    // Progressive rendering, component lifecycle & LRU caching
    private _renderedCount: number = BATCH_SIZE;
    private _scrollSentinelEl: HTMLElement | null = null;
    private _intersectionObserver: IntersectionObserver | null = null;
    private _isLoadingMore: boolean = false;
    private _renderedMarkdownCache: Map<string, HTMLElement> = new Map();
    private _streamComponent: Component | null = null;
    private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: HandumananPlugin) {
        super(leaf);
        this.plugin = plugin;
        this._isPrivacyShieldActive = Boolean(this.plugin.settings?.privacyShieldDefault);
    }

    getViewType(): string {
        return VIEW_TYPE_DESKTOP_HUB;
    }

    getDisplayText(): string {
        return 'Handumanan';
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

    private updateMobileNavbarVisibility(): void {
        const isMobile = Platform.isMobile && !isTablet(this.app);
        if (!isMobile) return;
        const doc = this.contentEl?.ownerDocument || document;
        doc.body.classList.toggle('pos-hide-mobile-navbar', this._isNavbarHidden);
        doc.body.classList.toggle('diwa-hide-mobile-navbar', this._isNavbarHidden);
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('diwa-workspace-root');
        this.contentEl.addClass('pos-scratchpad-view');

        const isMobile = Platform.isMobile && !isTablet(this.app);
        if (isMobile) {
            this.updateMobileNavbarVisibility();
            this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
                const doc = this.contentEl?.ownerDocument || document;
                if (leaf === this.leaf) {
                    doc.body.classList.toggle('pos-hide-mobile-navbar', this._isNavbarHidden);
                    doc.body.classList.toggle('diwa-hide-mobile-navbar', this._isNavbarHidden);
                } else {
                    doc.body.classList.remove('pos-hide-mobile-navbar');
                    doc.body.classList.remove('diwa-hide-mobile-navbar');
                }
            }));

            this._viewportCleanup = attachMobileSheetViewportBehavior({
                sheetEl: this.contentEl,
                scrollEl: this.contentEl,
            });

            // Prevent unwanted horizontal scrolling or drift on mobile runtimes
            const win = this.contentEl.ownerDocument.defaultView ?? window;
            const doc = this.contentEl.ownerDocument;
            const scrollLock = () => {
                if (win.scrollY !== 0 || win.scrollX !== 0) win.scrollTo(0, 0);
                if (doc.documentElement.scrollLeft !== 0) doc.documentElement.scrollLeft = 0;
                if (doc.body.scrollLeft !== 0) doc.body.scrollLeft = 0;
                if (this.contentEl.scrollLeft !== 0) this.contentEl.scrollLeft = 0;
            };
            win.addEventListener('scroll', scrollLock, { passive: true });
            this.contentEl.addEventListener('scroll', scrollLock, { passive: true });
            this.register(() => {
                win.removeEventListener('scroll', scrollLock);
                this.contentEl.removeEventListener('scroll', scrollLock);
            });
        }

        this.setupViewKeyHandler();
        this.renderView();

        // Click outside listener to dismiss mobile composer or inline editor
        this.contentEl.addEventListener('pointerdown', (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;

            if (this._mobileComposerOpen && this._composerEl) {
                if (!this._composerEl.contains(target) && !target.closest('.modal, .pos-modal, .suggestion-container, .menu, .suggestion-item')) {
                    this._mobileComposerOpen = false;
                    if (this._composerSlotEl) {
                        this.renderComposer(this._composerSlotEl, true);
                    }
                }
            }

            if (this._editingEntryId) {
                const editorEl = this.contentEl.querySelector('.pos-inline-edit-textarea, .pos-inline-edit-btns');
                if (editorEl && !editorEl.contains(target) && !target.closest('.modal, .pos-modal, .suggestion-container, .menu, .suggestion-item, .pos-note-stream-item')) {
                    this._editingEntryId = null;
                    this.updateStreamOnly();
                }
            }
        });
    }

    async onClose(): Promise<void> {
        const doc = this.contentEl?.ownerDocument || document;
        doc.body.classList.remove('pos-hide-mobile-navbar');
        doc.body.classList.remove('diwa-hide-mobile-navbar');

        if (this._viewportCleanup) {
            this._viewportCleanup();
            this._viewportCleanup = null;
        }

        if (this._keyHandler) {
            this.contentEl.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
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
        this._composerSlotEl = null;
        this._composerEl = null;
        this._streamContainerEl = null;
        this._filterBarEl = null;
        this._selectionBarEl = null;
    }

    private setupViewKeyHandler(): void {
        if (this._keyHandler) {
            this.contentEl.removeEventListener('keydown', this._keyHandler);
        }
        this._keyHandler = (e: KeyboardEvent) => {
            const activeEl = document.activeElement as HTMLElement | null;
            const isInsideInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

            // Escape handling
            if (e.key === 'Escape') {
                if (this._selectionMode) {
                    this._selectionMode = false;
                    this._selectedEntryIds.clear();
                    this.updateSelectionBar();
                    this.updateStreamOnly();
                    if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
                    return;
                }
                if (this._editingEntryId) {
                    this._editingEntryId = null;
                    this.updateStreamOnly();
                    return;
                }
                if (this._searchQuery || this._searchOpen) {
                    this._searchQuery = '';
                    this._searchOpen = false;
                    this.updateStreamOnly();
                    if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
                    return;
                }
                if (this._desktopComposerExpanded) {
                    const textarea = this._composerEl?.querySelector('textarea');
                    if (!textarea || !textarea.value.trim()) {
                        this._desktopComposerExpanded = false;
                        if (this._composerSlotEl) {
                            this.renderComposer(this._composerSlotEl, false);
                        }
                        if (textarea) textarea.blur();
                        return;
                    }
                }
                if (this._isSanctuaryMode) {
                    this._isSanctuaryMode = false;
                    this._containerEl?.toggleClass('is-sanctuary-mode', false);
                    if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
                    return;
                }
            }

            if (isInsideInput) return;

            // Hotkey: '/' or 'Cmd+F' -> Focus search
            if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f')) {
                e.preventDefault();
                if (!this._searchOpen && this._headerBarEl) {
                    this._searchOpen = true;
                    this.renderHeaderBar(this._headerBarEl);
                }
                const searchInput = this.contentEl.querySelector('.pos-search-input') as HTMLInputElement | null;
                if (searchInput) {
                    searchInput.focus();
                    searchInput.select();
                }
                return;
            }

            // Hotkey: 'c' or 'n' -> Focus / expand composer
            if (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'n') {
                e.preventDefault();
                this._desktopComposerExpanded = true;
                if (this._composerSlotEl) {
                    this.renderComposer(this._composerSlotEl, false);
                }
                const textarea = this._composerEl?.querySelector('textarea');
                if (textarea) {
                    textarea.focus({ preventScroll: true });
                }
                return;
            }
        };
        this.contentEl.addEventListener('keydown', this._keyHandler);
    }

    refreshAll(): void {
        this.renderView(false);
    }

    public focusComposer(): void {
        this._desktopComposerExpanded = true;
        if (this._composerSlotEl) {
            const isMobile = Platform.isMobile && !isTablet(this.app);
            this.renderComposer(this._composerSlotEl, isMobile);
        }
        setTimeout(() => {
            if (this._composerTextarea && this._composerTextarea.isConnected) {
                this._composerTextarea.focus({ preventScroll: true });
            }
        }, 50);
    }

    public togglePrivacyShield(): void {
        this._isPrivacyShieldActive = !this._isPrivacyShieldActive;
        this._containerEl?.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);
        if (this._headerBarEl) {
            this.renderHeaderBar(this._headerBarEl);
        }
    }

    renderView(resetPagination = true): void {
        if (resetPagination) {
            this._renderedCount = BATCH_SIZE;
        }

        const isMobile = Platform.isMobile && !isTablet(this.app);
        this.contentEl.empty();

        const container = this.contentEl.createDiv({ cls: 'pos-scratchpad-container' });
        this._containerEl = container;
        container.toggleClass('is-sanctuary-mode', this._isSanctuaryMode);
        container.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);

        // 1. Header Bar
        const header = container.createDiv({ cls: 'pos-header-bar' });
        this._headerBarEl = header;
        this.renderHeaderBar(header);

        // 2. Filter Carousel
        const filterBar = container.createDiv({ cls: 'pos-filter-bar' });
        this._filterBarEl = filterBar;
        this.renderFilterBar(filterBar);

        // 3. Selection Action Bar (hidden when selection mode is inactive)
        const selBarWrapper = container.createDiv({ cls: 'pos-selection-bar-wrapper' });
        this._selectionBarEl = selBarWrapper;
        this.updateSelectionBar();

        // 4. Hero Quick Capture (Desktop at top, anchored in dedicated slot)
        if (!isMobile) {
            const composerSlot = container.createDiv({ cls: 'pos-composer-slot' });
            this._composerSlotEl = composerSlot;
            this.renderComposer(composerSlot, false);
        }

        // 5. Continuous Document Stream
        const streamContainer = container.createDiv({ cls: 'pos-document-stream' });
        this._streamContainerEl = streamContainer;
        this.renderStream(streamContainer);

        // 6. Mobile Sticky / Floating Controls (at bottom)
        if (isMobile) {
            const composerSlot = container.createDiv({ cls: 'pos-composer-slot pos-mobile-composer-slot' });
            this._composerSlotEl = composerSlot;
            this.renderComposer(composerSlot, true);
        }
    }

    private renderHeaderBar(header: HTMLElement): void {
        header.empty();
        const isMobile = Platform.isMobile && !isTablet(this.app);

        // Title Section: Logo + Subtitle
        const titleSection = header.createDiv({ cls: 'pos-header-title-section' });
        titleSection.createSpan({ cls: 'pos-header-logo', text: 'Handumanan' });
        titleSection.createSpan({ cls: 'pos-header-subtitle', text: 'WORKSPACE' });

        // On mobile, header action icons are hidden and placed in the floating action bar
        if (isMobile) {
            return;
        }

        // Action Buttons Row (Single Row on Desktop/Tablet)
        const actions = header.createDiv({ cls: 'pos-header-actions' });

        // 1. Search (Desktop/Tablet: Icon button that expands inline in the same row)
        if (this._searchOpen || Boolean(this._searchQuery)) {
            const searchCapsule = actions.createDiv({ cls: 'pos-search-inline-capsule' });
            const searchIcon = searchCapsule.createSpan({ cls: 'pos-search-inline-icon' });
            setIcon(searchIcon, 'search');

            const searchInput = searchCapsule.createEl('input', {
                cls: 'pos-search-input pos-search-inline-input',
                type: 'text',
                placeholder: 'Search thoughts, #tags, or tasks...',
                value: this._searchQuery
            });

            searchInput.oninput = () => {
                if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
                this._searchDebounceTimer = setTimeout(() => {
                    this._searchQuery = searchInput.value.trim();
                    this._renderedCount = BATCH_SIZE;
                    this.updateStreamOnly();
                }, 150);
            };

            const closeBtn = searchCapsule.createEl('button', {
                cls: 'pos-search-inline-close',
                attr: { 'aria-label': 'Clear search' }
            });
            setIcon(closeBtn, 'x');
            closeBtn.onclick = () => {
                this._searchQuery = '';
                this._searchOpen = false;
                this._renderedCount = BATCH_SIZE;
                this.renderHeaderBar(header);
                this.updateStreamOnly();
            };
        } else {
            const searchBtn = actions.createEl('button', {
                cls: 'pos-icon-btn pos-search-toggle',
                attr: { 'aria-label': 'Search thoughts, #tags, or tasks (/)' }
            });
            setIcon(searchBtn, 'search');
            searchBtn.onclick = () => {
                this._searchOpen = true;
                this.renderHeaderBar(header);
                const input = header.querySelector('.pos-search-input') as HTMLInputElement | null;
                if (input) input.focus();
            };
        }

        // 2. Sanctuary Mode toggle (Icon button)
        const sanctuaryBtn = actions.createEl('button', {
            cls: `pos-icon-btn pos-sanctuary-btn ${this._isSanctuaryMode ? 'is-active' : ''}`,
            attr: { 'aria-label': this._isSanctuaryMode ? 'Exit Sanctuary Focus Mode' : 'Toggle Sanctuary Focus Mode' }
        });
        setIcon(sanctuaryBtn, 'book-open');
        sanctuaryBtn.onclick = () => {
            this._isSanctuaryMode = !this._isSanctuaryMode;
            this._containerEl?.toggleClass('is-sanctuary-mode', this._isSanctuaryMode);
            this.renderHeaderBar(header);
            if (this._isSanctuaryMode) {
                this._composerTextarea?.focus();
            }
        };

        // 3. Privacy Shield toggle (eye / eye-off)
        const privacyBtn = actions.createEl('button', {
            cls: `pos-icon-btn pos-privacy-toggle ${this._isPrivacyShieldActive ? 'is-active' : ''}`,
            attr: { 'aria-label': this._isPrivacyShieldActive ? 'Disable Privacy Shield' : 'Enable Privacy Shield (Blur Reflections)' }
        });
        setIcon(privacyBtn, this._isPrivacyShieldActive ? 'eye-off' : 'eye');
        privacyBtn.onclick = () => {
            this._isPrivacyShieldActive = !this._isPrivacyShieldActive;
            this._containerEl?.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);
            setIcon(privacyBtn, this._isPrivacyShieldActive ? 'eye-off' : 'eye');
            privacyBtn.toggleClass('is-active', this._isPrivacyShieldActive);
        };

        // 4. Resurface Serendipity button
        const resurfaceBtn = actions.createEl('button', {
            cls: 'pos-icon-btn pos-resurface-btn',
            attr: { 'aria-label': 'Resurface a memory' }
        });
        setIcon(resurfaceBtn, 'sparkles');
        resurfaceBtn.onclick = () => {
            const memory = this.plugin.index.getRandomMemory();
            if (!memory) {
                new Notice('No memories available to resurface.');
                return;
            }
            new Notice(`Resurfaced from ${moment(memory.createdAtMs).format('MMMM D, YYYY')}`);
            this._searchQuery = memory.title;
            this._searchOpen = true;
            this._renderedCount = BATCH_SIZE;
            this.renderHeaderBar(header);
            this.updateStreamOnly();
        };

        // 5. Settings trigger
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
        const taskEntriesCount = allEntries.filter(e => e.hasTasks || (e.tasks && e.tasks.length > 0)).length;
        const todayCount = this.plugin.index.getTodayCapturesCount();
        const favoritesCount = this.plugin.index.getFavorites().length;

        // 1. All Notes Chip
        this.createFilterChip(scrollable, 'all', 'All Notes', totalCount);

        // 2. Open Tasks Chip
        if (taskEntriesCount > 0) {
            this.createFilterChip(scrollable, 'tasks', '☑️ Open Tasks', taskEntriesCount, 'pos-chip-tasks');
        }

        // 3. Today Chip
        this.createFilterChip(scrollable, 'today', '📅 Today', todayCount, todayCount > 0 ? 'pos-chip-today' : '');

        // 4. Starred / Favorites Chip
        if (favoritesCount > 0) {
            this.createFilterChip(scrollable, 'favorites', '⭐ Starred', favoritesCount, 'pos-chip-gold');
        }

        // 5. Configured Contexts / Life Areas
        const contexts = this.plugin.getContexts();
        for (const ctx of contexts.slice(0, 8)) {
            const count = allEntries.filter(e => e.tags && e.tags.includes(ctx.toLowerCase().replace(/^#/, ''))).length;
            if (count > 0) {
                this.createFilterChip(scrollable, ctx, `#${ctx}`, count);
            }
        }
    }

    private createFilterChip(parent: HTMLElement, filterId: ScratchpadFilterMode, label: string, count: number, extraCls = ''): HTMLElement {
        const isActive = this._activeFilter === filterId;
        const chip = parent.createDiv({
            cls: `pos-filter-chip ${isActive ? 'is-active' : ''} ${extraCls}`,
            attr: {
                role: 'button',
                tabindex: '0',
                'aria-pressed': String(isActive)
            }
        });
        chip.createSpan({ cls: 'pos-chip-label', text: label });
        chip.createSpan({ cls: 'pos-chip-badge', text: `${count}` });

        const toggleFilter = () => {
            this._activeFilter = this._activeFilter === filterId ? 'all' : filterId;
            this._renderedCount = BATCH_SIZE;
            if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
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

    private updateSelectionBar(): void {
        if (!this._selectionBarEl) return;
        this._selectionBarEl.empty();

        if (!this._selectionMode || this._selectedEntryIds.size === 0) {
            this._selectionBarEl.style.display = 'none';
            return;
        }

        this._selectionBarEl.style.display = 'block';
        const bar = this._selectionBarEl.createDiv({ cls: 'pos-selection-bar' });

        const text = bar.createSpan({
            cls: 'pos-selection-text',
            text: `${this._selectedEntryIds.size} note${this._selectedEntryIds.size === 1 ? '' : 's'} selected`
        });

        const actions = bar.createDiv({ cls: 'pos-selection-actions' });

        const mergeBtn = actions.createEl('button', {
            cls: 'pos-action-btn pos-btn-primary pos-selection-btn',
            text: 'Weave / Merge'
        });
        mergeBtn.onclick = () => {
            const selectedFiles = Array.from(this._selectedEntryIds);
            const entries = selectedFiles
                .map(id => this.plugin.index.journalIndex.get(id))
                .filter((e): e is JournalEntry => e !== undefined);

            new MergeNotesModal(this.app, this.plugin, entries, () => {
                this._selectedEntryIds.clear();
                this._selectionMode = false;
                if (this._headerBarEl) this.renderHeaderBar(this._headerBarEl);
                this.updateSelectionBar();
                this.updateStreamOnly();
            }).open();
        };

        const clearBtn = actions.createEl('button', {
            cls: 'pos-action-btn pos-selection-btn',
            text: 'Clear'
        });
        clearBtn.onclick = () => {
            this._selectedEntryIds.clear();
            this.updateSelectionBar();
            this.updateStreamOnly();
        };
    }

    private renderComposer(parent: HTMLElement, isMobile: boolean): void {
        if (parent === this._containerEl && this._composerSlotEl) {
            parent = this._composerSlotEl;
        }

        // === MOBILE VIEW COMPOSER ===
        if (isMobile) {
            parent.empty();

            // 1. Mobile Floating Search Capsule when search is open
            if (this._mobileSearchOpen || Boolean(this._searchQuery)) {
                const searchWrapper = parent.createDiv({ cls: 'pos-mobile-floating-search' });
                this._composerEl = searchWrapper;

                const iconEl = searchWrapper.createDiv({ cls: 'pos-mobile-search-icon' });
                setIcon(iconEl, 'search');

                const searchInput = searchWrapper.createEl('input', {
                    type: 'search',
                    placeholder: 'Search notes, #tags, or tasks...',
                    cls: 'pos-mobile-search-input',
                    value: this._searchQuery,
                    attr: { enterkeyhint: 'search' }
                });

                searchInput.oninput = () => {
                    if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
                    this._searchDebounceTimer = setTimeout(() => {
                        this._searchQuery = searchInput.value.trim();
                        this._renderedCount = BATCH_SIZE;
                        this.updateStreamOnly();
                    }, 120);
                };

                const clearBtn = searchWrapper.createEl('button', {
                    cls: 'pos-mobile-search-clear',
                    attr: { 'aria-label': 'Close search' }
                });
                setIcon(clearBtn, 'x');
                clearBtn.onclick = () => {
                    this._searchQuery = '';
                    this._mobileSearchOpen = false;
                    this._renderedCount = BATCH_SIZE;
                    this.updateStreamOnly();
                    this.renderComposer(parent, true);
                };

                setTimeout(() => { if (searchInput.isConnected) searchInput.focus(); }, 60);
                return;
            }

            // 2. Mobile Idle Floating Action Bar (1-row frosted glass)
            if (!this._mobileComposerOpen) {
                const actionBar = parent.createDiv({ cls: 'pos-mobile-action-bar' });
                this._composerEl = actionBar;

                // 1. Capture Note trigger
                const newBtn = actionBar.createEl('button', {
                    cls: 'pos-mobile-action-btn pos-mobile-action-new',
                    attr: { 'aria-label': 'Capture reflection or thought' }
                });
                setIcon(newBtn, 'edit-3');
                newBtn.onclick = () => {
                    this._mobileComposerOpen = true;
                    this.renderComposer(parent, true);
                };

                // 2. Search trigger
                const isSearchActive = this._mobileSearchOpen || Boolean(this._searchQuery);
                const searchBtn = actionBar.createEl('button', {
                    cls: `pos-mobile-action-btn ${isSearchActive ? 'is-active' : ''}`,
                    attr: { 'aria-label': 'Search journal' }
                });
                setIcon(searchBtn, 'search');
                searchBtn.onclick = () => {
                    this._mobileSearchOpen = true;
                    this.renderComposer(parent, true);
                };

                // 3. Sanctuary Mode toggle
                const sanctuaryBtn = actionBar.createEl('button', {
                    cls: `pos-mobile-action-btn pos-sanctuary-btn ${this._isSanctuaryMode ? 'is-active' : ''}`,
                    attr: { 'aria-label': this._isSanctuaryMode ? 'Exit Sanctuary Focus Mode' : 'Toggle Sanctuary Focus Mode' }
                });
                setIcon(sanctuaryBtn, 'book-open');
                sanctuaryBtn.onclick = () => {
                    this._isSanctuaryMode = !this._isSanctuaryMode;
                    this._containerEl?.toggleClass('is-sanctuary-mode', this._isSanctuaryMode);
                    sanctuaryBtn.toggleClass('is-active', this._isSanctuaryMode);
                    new Notice(this._isSanctuaryMode ? 'Entered Sanctuary mode' : 'Exited Sanctuary mode');
                };

                // 4. Privacy Shield toggle
                const privacyBtn = actionBar.createEl('button', {
                    cls: `pos-mobile-action-btn pos-privacy-toggle ${this._isPrivacyShieldActive ? 'is-active' : ''}`,
                    attr: { 'aria-label': this._isPrivacyShieldActive ? 'Disable Privacy Shield' : 'Enable Privacy Shield (Blur Reflections)' }
                });
                setIcon(privacyBtn, this._isPrivacyShieldActive ? 'eye-off' : 'eye');
                privacyBtn.onclick = () => {
                    this._isPrivacyShieldActive = !this._isPrivacyShieldActive;
                    this._containerEl?.toggleClass('is-privacy-shield-active', this._isPrivacyShieldActive);
                    setIcon(privacyBtn, this._isPrivacyShieldActive ? 'eye-off' : 'eye');
                    privacyBtn.toggleClass('is-active', this._isPrivacyShieldActive);
                    new Notice(this._isPrivacyShieldActive ? 'Privacy Shield enabled' : 'Privacy Shield disabled');
                };

                // 5. Resurface Serendipity button
                const resurfaceBtn = actionBar.createEl('button', {
                    cls: 'pos-mobile-action-btn pos-resurface-btn',
                    attr: { 'aria-label': 'Resurface a memory' }
                });
                setIcon(resurfaceBtn, 'sparkles');
                resurfaceBtn.onclick = () => {
                    const memory = this.plugin.index.getRandomMemory();
                    if (!memory) {
                        new Notice('No memories available to resurface.');
                        return;
                    }
                    new Notice(`Resurfaced from ${moment(memory.createdAtMs).format('MMMM D, YYYY')}`);
                    this._searchQuery = memory.title;
                    this._renderedCount = BATCH_SIZE;
                    this.updateStreamOnly();
                    searchBtn.addClass('is-active');
                };

                // 6. Navigation Bar toggle
                const navbarBtn = actionBar.createEl('button', {
                    cls: `pos-mobile-action-btn pos-navbar-toggle ${!this._isNavbarHidden ? 'is-active' : ''}`,
                    attr: { 'aria-label': this._isNavbarHidden ? 'Show Obsidian navigation bar' : 'Hide Obsidian navigation bar' }
                });
                setIcon(navbarBtn, this._isNavbarHidden ? ICON_PANEL_BOTTOM_SHOW_ID : ICON_PANEL_BOTTOM_HIDE_ID);
                navbarBtn.onclick = () => {
                    this._isNavbarHidden = !this._isNavbarHidden;
                    this.updateMobileNavbarVisibility();
                    setIcon(navbarBtn, this._isNavbarHidden ? ICON_PANEL_BOTTOM_SHOW_ID : ICON_PANEL_BOTTOM_HIDE_ID);
                    navbarBtn.toggleClass('is-active', !this._isNavbarHidden);
                    navbarBtn.setAttribute('aria-label', this._isNavbarHidden ? 'Show Obsidian navigation bar' : 'Hide Obsidian navigation bar');
                    new Notice(this._isNavbarHidden ? 'Obsidian navigation bar hidden' : 'Obsidian navigation bar shown');
                };

                // 7. Settings trigger
                const settingsBtn = actionBar.createEl('button', {
                    cls: 'pos-mobile-action-btn pos-settings-trigger',
                    attr: { 'aria-label': 'Settings' }
                });
                setIcon(settingsBtn, 'settings');
                settingsBtn.onclick = () => {
                    (this.app as any).setting?.open();
                    (this.app as any).setting?.openTabById?.(this.plugin.manifest.id);
                };

                return;
            }

            // 3. Mobile Sticky Composer (Expanded active state)
            const stickyComposer = parent.createDiv({ cls: 'pos-mobile-sticky-composer' });
            this._composerEl = stickyComposer;

            const mainRow = stickyComposer.createDiv({ cls: 'pos-mobile-composer-main-row' });
            const textarea = mainRow.createEl('textarea', {
                cls: 'pos-composer-textarea',
                placeholder: 'Capture a thought, note, or task...',
                attr: { rows: '2' }
            });
            this._composerTextarea = textarea;

            const sendBtn = mainRow.createEl('button', {
                cls: 'pos-composer-save-btn pos-mobile-send-btn',
                text: '↑',
                attr: { 'aria-label': 'Save note' }
            });

            // Accessory toolbar (Task, Area, Close)
            const pillRow = stickyComposer.createDiv({ cls: 'pos-composer-toolbar' });
            const leftPills = pillRow.createDiv({ cls: 'pos-composer-left' });

            const taskBtn = leftPills.createEl('button', {
                cls: 'pos-composer-pill-btn',
                attr: { 'aria-label': 'Insert task' }
            });
            const taskIcon = taskBtn.createSpan({ cls: 'pos-btn-icon' });
            setIcon(taskIcon, 'check-square');
            taskBtn.createSpan({ text: 'Task' });
            taskBtn.onclick = () => {
                const cursor = textarea.selectionStart || 0;
                const text = textarea.value;
                const prefix = (cursor > 0 && text[cursor - 1] !== '\n') ? '\n- [ ] ' : '- [ ] ';
                textarea.value = text.slice(0, cursor) + prefix + text.slice(cursor);
                textarea.focus();
                textarea.setSelectionRange(cursor + prefix.length, cursor + prefix.length);
            };

            const closeBtn = pillRow.createEl('button', {
                cls: 'pos-composer-close-btn',
                attr: { 'aria-label': 'Close composer' }
            });
            setIcon(closeBtn, 'x');
            closeBtn.onclick = () => {
                this._mobileComposerOpen = false;
                this.renderComposer(parent, true);
            };

            // Draft restore & Auto-resize
            const draft = this.plugin.capture.getDraft();
            if (draft) textarea.value = draft;

            textarea.oninput = () => {
                textarea.style.height = 'auto';
                textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
                this.plugin.capture.saveDraft(textarea.value);
            };

            attachInlineTriggers(this.app, textarea, undefined, undefined, () => this.plugin.getContexts(), this.plugin.settings?.peopleFolder);
            attachMediaPasteHandler(this.app, textarea, () => this.plugin.settings?.attachmentsFolder || '000 Bin/Handumanan Attachments');

            const doSave = async () => {
                const text = textarea.value.trim();
                if (!text) return;
                sendBtn.disabled = true;
                try {
                    await this.plugin.capture.createCaptureNote(text, this._selectedAreaForNewNote, []);
                    this.plugin.capture.clearDraft();
                    textarea.value = '';
                    this._mobileComposerOpen = false;
                    this.renderComposer(parent, true);
                    this.updateStreamOnly();
                    new Notice('Note captured!');
                } catch (err) {
                    new Notice('Failed to save note');
                } finally {
                    sendBtn.disabled = false;
                }
            };
            sendBtn.onclick = doSave;
            return;
        }

        // === DESKTOP / TABLET HERO COMPOSER ===
        parent.empty();

        const draft = this.plugin.capture.getDraft();
        const hasDraft = Boolean(draft && draft.trim().length > 0);
        const isExpanded = this._desktopComposerExpanded || hasDraft;

        if (!isExpanded) {
            // Sleek Reflect-style fluid capture line (idle state)
            const compactWrapper = parent.createDiv({
                cls: 'pos-composer-compact pos-reflect-composer-compact',
                attr: {
                    tabindex: '0',
                    role: 'button',
                    'aria-label': 'Click to capture note or task'
                }
            });
            this._composerEl = compactWrapper;

            const triggerArea = compactWrapper.createDiv({ cls: 'pos-compact-trigger-area' });
            const editIcon = triggerArea.createSpan({ cls: 'pos-compact-icon' });
            setIcon(editIcon, 'edit-3');
            triggerArea.createSpan({ cls: 'pos-compact-placeholder', text: "Capture your thought..." });

            const activate = () => {
                this._desktopComposerExpanded = true;
                this.renderComposer(parent, false);
                const ta = this._composerEl?.querySelector('textarea');
                if (ta) ta.focus({ preventScroll: true });
            };

            compactWrapper.onclick = activate;
            compactWrapper.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activate();
                }
            };
            return;
        }

        // Expanded Desktop Hero Composer
        const composerWrapper = parent.createDiv({ cls: 'pos-composer pos-desktop-composer' });
        this._composerEl = composerWrapper;

        const textarea = composerWrapper.createEl('textarea', {
            cls: 'pos-composer-textarea pos-desktop-composer-textarea',
            placeholder: 'What’s on your mind? Capture a thought, task (- [ ]), or note...',
            attr: { rows: '2' }
        });
        this._composerTextarea = textarea;

        if (draft) textarea.value = draft;

        // Auto-expand without forced reflow
        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
        };
        textarea.oninput = () => {
            autoResize();
            this.plugin.capture.saveDraft(textarea.value);
        };
        setTimeout(autoResize, 0);

        attachInlineTriggers(this.app, textarea, undefined, undefined, () => this.plugin.getContexts(), this.plugin.settings?.peopleFolder);
        attachMediaPasteHandler(this.app, textarea, () => this.plugin.settings?.attachmentsFolder || '000 Bin/Handumanan Attachments');

        // Composer Toolbar
        const toolbar = composerWrapper.createDiv({ cls: 'pos-composer-toolbar' });
        const leftControls = toolbar.createDiv({ cls: 'pos-composer-left' });

        // Task Button Pill
        const taskBtn = leftControls.createEl('button', {
            cls: 'pos-composer-pill-btn pos-composer-task-btn',
            attr: { 'aria-label': 'Insert task checkbox' }
        });
        const taskIcon = taskBtn.createSpan({ cls: 'pos-btn-icon' });
        setIcon(taskIcon, 'check-square');
        taskBtn.createSpan({ text: 'Task' });
        taskBtn.onclick = () => {
            const cursor = textarea.selectionStart || 0;
            const text = textarea.value;
            const prefix = (cursor > 0 && text[cursor - 1] !== '\n') ? '\n- [ ] ' : '- [ ] ';
            textarea.value = text.slice(0, cursor) + prefix + text.slice(cursor);
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(cursor + prefix.length, cursor + prefix.length);
            autoResize();
            this.plugin.capture.saveDraft(textarea.value);
        };

        // Important / Star Button Pill
        const starBtn = leftControls.createEl('button', {
            cls: `pos-composer-pill-btn pos-composer-star-btn ${this._selectedImportantForNewNote ? 'is-selected' : ''}`,
            attr: { 'aria-label': 'Toggle important flag' }
        });
        const starIcon = starBtn.createSpan({ cls: 'pos-btn-icon' });
        setIcon(starIcon, 'star');
        starBtn.createSpan({ text: 'Important' });
        starBtn.onclick = () => {
            this._selectedImportantForNewNote = !this._selectedImportantForNewNote;
            starBtn.toggleClass('is-selected', this._selectedImportantForNewNote);
        };

        // Context / Area Dropdown Pill
        const areaBtn = leftControls.createEl('button', {
            cls: `pos-composer-pill-btn ${this._selectedAreaForNewNote ? 'is-selected' : ''}`,
            attr: { 'aria-label': 'Select area/context' }
        });
        const areaIcon = areaBtn.createSpan({ cls: 'pos-btn-icon' });
        setIcon(areaIcon, 'tag');
        const areaLabel = areaBtn.createSpan({ text: this._selectedAreaForNewNote ? `#${this._selectedAreaForNewNote}` : 'Area ▾' });

        areaBtn.onclick = (e) => {
            const menu = new Menu();
            menu.addItem((item) => {
                item.setTitle('No Context (General)')
                    .setIcon('minus-circle')
                    .setChecked(!this._selectedAreaForNewNote)
                    .onClick(() => {
                        this._selectedAreaForNewNote = '';
                        areaLabel.setText('Area ▾');
                        areaBtn.removeClass('is-selected');
                    });
            });
            menu.addSeparator();
            for (const ctx of this.plugin.getContexts()) {
                menu.addItem((item) => {
                    item.setTitle(`#${ctx}`)
                        .setChecked(this._selectedAreaForNewNote === ctx)
                        .onClick(() => {
                            this._selectedAreaForNewNote = ctx;
                            areaLabel.setText(`#${ctx}`);
                            areaBtn.addClass('is-selected');
                        });
                });
            }
            menu.showAtMouseEvent(e);
        };

        // Privacy lock toggle pill
        const lockBtn = leftControls.createEl('button', {
            cls: `pos-composer-pill-btn ${this._isEntryPrivate ? 'is-selected' : ''}`,
            attr: { 'aria-label': this._isEntryPrivate ? 'Marked Private' : 'Mark entry private' }
        });
        const lockIcon = lockBtn.createSpan({ cls: 'pos-btn-icon' });
        setIcon(lockIcon, this._isEntryPrivate ? 'lock' : 'unlock');
        lockBtn.createSpan({ text: this._isEntryPrivate ? 'Private' : 'Lock' });
        lockBtn.onclick = () => {
            this._isEntryPrivate = !this._isEntryPrivate;
            lockBtn.toggleClass('is-selected', this._isEntryPrivate);
            lockIcon.empty();
            setIcon(lockIcon, this._isEntryPrivate ? 'lock' : 'unlock');
        };

        // Right Controls: Hint + Close + Save
        const rightControls = toolbar.createDiv({ cls: 'pos-composer-right' });
        rightControls.createSpan({ cls: 'pos-composer-hint', text: '⌘↵ Save · ⇧↵ Next' });

        const closeBtn = rightControls.createEl('button', {
            cls: 'pos-composer-close-btn',
            attr: { 'aria-label': 'Close composer' }
        });
        setIcon(closeBtn, 'x');
        closeBtn.onclick = () => {
            this._desktopComposerExpanded = false;
            this.renderComposer(parent, false);
        };

        const saveBtn = rightControls.createEl('button', {
            cls: 'pos-composer-save-btn',
            text: 'Capture Note',
            attr: { 'aria-label': 'Save note (⌘ Enter)' }
        });
        this._composerSubmitBtn = saveBtn;

        const doSave = async (keepActive = false) => {
            const text = textarea.value.trim();
            if (!text) return;
            saveBtn.disabled = true;
            this._capturePending++;
            try {
                await this.plugin.capture.createJournalEntry(text, {
                    isPrivate: this._isEntryPrivate,
                    tags: this._selectedAreaForNewNote ? [this._selectedAreaForNewNote] : [],
                });

                if (this._selectedImportantForNewNote) {
                    const latest = this.plugin.index.getAllCaptures()[0];
                    if (latest) {
                        await this.plugin.capture.toggleFavorite(latest.filePath);
                        latest.favorite = true;
                    }
                }

                this.plugin.capture.clearDraft();
                textarea.value = '';
                autoResize();

                if (keepActive) {
                    new Notice('Captured! Ready for next ↵', 1500);
                    textarea.focus();
                } else {
                    this._selectedAreaForNewNote = '';
                    this._selectedImportantForNewNote = false;
                    this._desktopComposerExpanded = false;
                    this.renderComposer(parent, false);
                    new Notice('Note captured!');
                }
                this.updateStreamOnly();
                if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
            } catch (err) {
                new Notice('Failed to save note');
            } finally {
                this._capturePending--;
                saveBtn.disabled = false;
            }
        };

        saveBtn.onclick = () => { void doSave(false); };

        textarea.onkeydown = (e) => {
            if (e.shiftKey && e.key === 'Enter') {
                e.preventDefault();
                void doSave(true);
            } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void doSave(false);
            }
        };
    }

    private getFilteredCaptures(): JournalEntry[] {
        let entries = this.plugin.index.getAllCaptures();

        // 1. Text Search Filter
        if (this._searchQuery) {
            const q = this._searchQuery.toLowerCase();
            entries = entries.filter(e => {
                const bodyMatch = e.body && e.body.toLowerCase().includes(q);
                const titleMatch = e.title && e.title.toLowerCase().includes(q);
                const tagMatch = e.tags && e.tags.some(t => t.toLowerCase().includes(q));
                return bodyMatch || titleMatch || tagMatch;
            });
        }

        // 2. Active Tab Filter
        if (this._activeFilter === 'today') {
            const todayStr = moment().format('YYYY-MM-DD');
            entries = entries.filter(e => e.day === todayStr);
        } else if (this._activeFilter === 'favorites') {
            entries = entries.filter(e => e.favorite || e.pinned);
        } else if (this._activeFilter === 'tasks') {
            entries = entries.filter(e => e.hasTasks || (e.tasks && e.tasks.length > 0));
        } else if (this._activeFilter !== 'all') {
            // Context filter
            const normFilter = this._activeFilter.toLowerCase().replace(/^#/, '');
            entries = entries.filter(e => e.tags && e.tags.includes(normFilter));
        }

        return entries;
    }

    private getDateHeadingForEntry(entry: JournalEntry): string {
        const entryMoment = moment(entry.createdAtMs);
        const now = moment();
        const dayStr = entry.day || entryMoment.format('YYYY-MM-DD');

        if (dayStr === now.format('YYYY-MM-DD')) {
            return `Today · ${entryMoment.format('MMMM D')}`;
        }
        if (dayStr === now.clone().subtract(1, 'day').format('YYYY-MM-DD')) {
            return `Yesterday · ${entryMoment.format('MMMM D')}`;
        }
        if (entryMoment.isSame(now, 'year')) {
            return entryMoment.format('dddd, MMMM D');
        }
        return entryMoment.format('MMMM D, YYYY');
    }

    private renderStream(container: HTMLElement): void {
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
        }

        if (this._streamComponent) {
            this._streamComponent.unload();
            this.removeChild(this._streamComponent);
            this._streamComponent = null;
        }
        this._streamComponent = this.addChild(new Component());

        container.empty();

        const filtered = this.getFilteredCaptures();
        const trimmedQuery = this._searchQuery.trim();

        if (filtered.length === 0) {
            const emptyEl = container.createDiv({ cls: 'pos-stream-empty-state' });
            const iconEl = emptyEl.createDiv({ cls: 'pos-empty-icon' });
            setIcon(iconEl, trimmedQuery ? 'search' : 'file-text');

            const title = trimmedQuery 
                ? `No notes matching "${trimmedQuery}"` 
                : 'Your stream is clear and ready';
            const subtitle = trimmedQuery 
                ? 'Check spelling or try a different keyword.' 
                : 'Type above or press C to capture thoughts, ideas, or to-dos.';

            emptyEl.createEl('h3', { text: title });
            emptyEl.createEl('p', { text: subtitle });
            return;
        }

        const visibleEntries = filtered.slice(0, this._renderedCount);

        // Precompute note counts per date cluster
        const dateCounts = new Map<string, number>();
        for (const entry of filtered) {
            const key = this.getDateHeadingForEntry(entry);
            dateCounts.set(key, (dateCounts.get(key) || 0) + 1);
        }

        let lastDateKey = '';
        for (const entry of visibleEntries) {
            const dateKey = this.getDateHeadingForEntry(entry);
            if (dateKey !== lastDateKey) {
                lastDateKey = dateKey;
                const divider = container.createDiv({ cls: 'pos-date-divider' });
                divider.createSpan({ cls: 'pos-date-heading', text: dateKey });
                const count = dateCounts.get(dateKey) || 1;
                divider.createSpan({ cls: 'pos-date-count', text: `${count}` });
                divider.createDiv({ cls: 'pos-date-line' });
            }

            this.renderNoteItem(container, entry);
        }

        // Setup progressive lazy-load sentinel
        if (this._renderedCount < filtered.length) {
            if (!this._scrollSentinelEl) {
                this._scrollSentinelEl = document.createElement('div');
                this._scrollSentinelEl.className = 'pos-scroll-sentinel';
            }
            container.appendChild(this._scrollSentinelEl);
            this.setupIntersectionObserver(filtered.length);
        } else if (this._scrollSentinelEl) {
            this._scrollSentinelEl.remove();
            this._scrollSentinelEl = null;
        }
    }

    private setupIntersectionObserver(totalCount: number): void {
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
        }

        this._intersectionObserver = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this._isLoadingMore) {
                if (this._renderedCount < totalCount && this._streamContainerEl) {
                    this._isLoadingMore = true;
                    this.appendNextBatch(this._streamContainerEl, totalCount);
                    this._isLoadingMore = false;
                }
            }
        }, { rootMargin: '300px' });

        if (this._scrollSentinelEl) {
            this._intersectionObserver.observe(this._scrollSentinelEl);
        }
    }

    private appendNextBatch(container: HTMLElement, totalFiltered: number): void {
        const filtered = this.getFilteredCaptures();
        const startIdx = this._renderedCount;
        const nextCount = Math.min(startIdx + BATCH_SIZE, filtered.length);
        const newBatch = filtered.slice(startIdx, nextCount);
        this._renderedCount = nextCount;

        if (this._scrollSentinelEl) {
            this._scrollSentinelEl.remove();
        }

        const dateCounts = new Map<string, number>();
        for (const entry of filtered) {
            const key = this.getDateHeadingForEntry(entry);
            dateCounts.set(key, (dateCounts.get(key) || 0) + 1);
        }

        const dateDividers = container.querySelectorAll<HTMLElement>('.pos-date-heading');
        let lastDateKey = dateDividers.length > 0 ? dateDividers[dateDividers.length - 1].textContent || '' : '';

        for (const entry of newBatch) {
            const dateKey = this.getDateHeadingForEntry(entry);
            if (dateKey !== lastDateKey) {
                lastDateKey = dateKey;
                const divider = container.createDiv({ cls: 'pos-date-divider' });
                divider.createSpan({ cls: 'pos-date-heading', text: dateKey });
                const count = dateCounts.get(dateKey) || 1;
                divider.createSpan({ cls: 'pos-date-count', text: `${count}` });
                divider.createDiv({ cls: 'pos-date-line' });
            }

            this.renderNoteItem(container, entry);
        }

        if (this._renderedCount < totalFiltered && this._scrollSentinelEl) {
            container.appendChild(this._scrollSentinelEl);
            if (this._intersectionObserver) {
                this._intersectionObserver.observe(this._scrollSentinelEl);
            }
        }
    }

    private renderNoteItem(parent: HTMLElement, entry: JournalEntry): void {
        const isSelected = this._selectedEntryIds.has(entry.id);
        const isImportant = this.plugin.index.isImportant(entry);
        const isEditing = this._editingEntryId === entry.id;
        const hasTasks = Boolean(entry.hasTasks || (entry.tasks && entry.tasks.length > 0));

        const item = parent.createDiv({
            cls: `pos-note-stream-item ${isSelected ? 'is-selected' : ''} ${this._selectionMode ? 'is-selection-mode' : ''} ${isImportant ? 'is-important' : ''} ${hasTasks ? 'has-tasks' : ''} ${isEditing ? 'is-editing' : ''}`
        });

        // Double-click to inline edit
        if (!this._selectionMode) {
            item.ondblclick = (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.pos-interactive-checkbox') || target.closest('.pos-note-actions') || target.closest('a') || target.closest('img')) {
                    return;
                }
                this._editingEntryId = entry.id;
                this.updateStreamOnly();
            };
        } else {
            item.onclick = (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.pos-interactive-checkbox') || target.closest('.pos-note-actions') || target.closest('a')) {
                    return;
                }
                if (this._selectedEntryIds.has(entry.id)) {
                    this._selectedEntryIds.delete(entry.id);
                } else {
                    this._selectedEntryIds.add(entry.id);
                }
                item.toggleClass('is-selected', this._selectedEntryIds.has(entry.id));
                this.updateSelectionBar();
            };
        }

        const isMobile = Platform.isMobile && !isTablet(this.app);
        const timeStr = moment(entry.createdAtMs).format('h:mm A');

        // Mobile Micro-Card Layout
        if (isMobile) {
            item.addClass('is-mobile-card');

            if (isEditing) {
                const editorWrapper = item.createDiv({ cls: 'pos-note-content-wrap pos-inline-editor-wrap' });
                this.renderInlineEditor(editorWrapper, entry);
                return;
            }

            const cardHeader = item.createDiv({ cls: 'pos-mobile-card-header' });
            const headerLeft = cardHeader.createDiv({ cls: 'pos-mobile-card-header-left' });

            if (this._selectionMode) {
                const cb = headerLeft.createEl('input', { type: 'checkbox', cls: 'pos-select-checkbox' });
                cb.checked = isSelected;
                cb.onclick = (e) => {
                    e.stopPropagation();
                    if (cb.checked) this._selectedEntryIds.add(entry.id);
                    else this._selectedEntryIds.delete(entry.id);
                    item.toggleClass('is-selected', cb.checked);
                    this.updateSelectionBar();
                };
            }

            headerLeft.createSpan({ cls: 'pos-note-time', text: timeStr });

            const actionsEl = cardHeader.createDiv({ cls: 'pos-note-actions pos-mobile-card-actions' });
            const starBtn = actionsEl.createSpan({
                cls: `pos-action-icon pos-star-btn ${isImportant ? 'is-starred' : ''}`,
                attr: { 'aria-label': 'Toggle Star' }
            });
            setIcon(starBtn, 'star');
            starBtn.onclick = async (e) => {
                e.stopPropagation();
                const newState = await this.plugin.capture.toggleNoteImportance(entry.filePath);
                entry.favorite = newState;
                entry.pinned = newState;
                this.invalidateRenderCacheForFile(entry.filePath);
                this.updateStreamOnly();
                if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
            };

            const moreBtn = actionsEl.createSpan({ cls: 'pos-action-icon pos-action-more', attr: { 'aria-label': 'Options' } });
            setIcon(moreBtn, 'more-horizontal');
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                this.openNoteActionMenu(e, entry);
            };

            const contentWrap = item.createDiv({ cls: 'pos-note-content-wrap' });
            const bodyEl = contentWrap.createDiv({ cls: 'pos-note-body markdown-rendered' });
            this.renderEntryMarkdown(bodyEl, entry);
            return;
        }

        // Desktop Inline Editing State
        if (isEditing) {
            item.addClass('is-editing');
            const gutterEl = item.createDiv({ cls: 'pos-note-gutter' });
            gutterEl.createSpan({ cls: 'pos-note-time', text: timeStr });

            const editorWrapper = item.createDiv({ cls: 'pos-note-content-wrap pos-inline-editor-wrap' });
            this.renderInlineEditor(editorWrapper, entry);
            return;
        }

        // Desktop Horizontal Outliner Row
        // 1. Left Gutter (Time + Checkbox)
        const gutter = item.createDiv({ cls: 'pos-note-gutter' });
        if (this._selectionMode) {
            const cb = gutter.createEl('input', { type: 'checkbox', cls: 'pos-select-checkbox' });
            cb.checked = isSelected;
            cb.onclick = (e) => {
                e.stopPropagation();
                if (cb.checked) this._selectedEntryIds.add(entry.id);
                else this._selectedEntryIds.delete(entry.id);
                item.toggleClass('is-selected', cb.checked);
                this.updateSelectionBar();
            };
        }
        gutter.createSpan({ cls: 'pos-note-time', text: timeStr });

        // 2. Content Wrap (Body + Badges + Actions)
        const contentWrap = item.createDiv({ cls: 'pos-note-content-wrap' });

        // Body with Markdown Renderer (rendered first so text baseline aligns directly with time)
        const bodyEl = contentWrap.createDiv({ cls: 'pos-note-body markdown-rendered' });
        this.renderEntryMarkdown(bodyEl, entry);

        // Badges container (placed after body for natural reading flow and perfect time alignment)
        if ((entry.tags && entry.tags.length > 0) || entry.private) {
            const badges = contentWrap.createDiv({ cls: 'pos-note-badges' });
            if (entry.private) {
                const privBadge = badges.createSpan({ cls: 'pos-tag-badge' });
                setIcon(privBadge, 'lock');
            }
            if (entry.tags) {
                for (const t of entry.tags) {
                    const tagBadge = badges.createSpan({ cls: 'pos-tag-badge', text: `#${t}` });
                    tagBadge.onclick = (e) => {
                        e.stopPropagation();
                        this._activeFilter = t;
                        if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
                        this.updateStreamOnly();
                    };
                }
            }
        }

        // Hover Action Buttons (Right-aligned)
        const actionsEl = item.createDiv({ cls: 'pos-note-actions' });

        const starBtn = actionsEl.createSpan({
            cls: `pos-action-icon pos-star-btn ${isImportant ? 'is-starred' : ''}`,
            attr: { 'aria-label': isImportant ? 'Unstar note' : 'Star note' }
        });
        setIcon(starBtn, 'star');
        starBtn.onclick = async (e) => {
            e.stopPropagation();
            const newState = await this.plugin.capture.toggleNoteImportance(entry.filePath);
            entry.favorite = newState;
            entry.pinned = newState;
            this.invalidateRenderCacheForFile(entry.filePath);
            this.updateStreamOnly();
            if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
        };

        const editBtn = actionsEl.createSpan({ cls: 'pos-action-icon pos-edit-btn', attr: { 'aria-label': 'Edit note' } });
        setIcon(editBtn, 'pencil');
        editBtn.onclick = (e) => {
            e.stopPropagation();
            this._editingEntryId = entry.id;
            this.updateStreamOnly();
        };

        const trashBtn = actionsEl.createSpan({ cls: 'pos-action-icon pos-trash-btn', attr: { 'aria-label': 'Delete note' } });
        setIcon(trashBtn, 'trash-2');
        trashBtn.onclick = async (e) => {
            e.stopPropagation();
            const confirmed = window.confirm('Move note to trash?');
            if (!confirmed) return;
            await this.plugin.capture.deleteNote(entry.filePath);
            item.remove();
            new Notice('Note moved to trash');
        };

        const moreBtn = actionsEl.createSpan({ cls: 'pos-action-icon pos-action-more', attr: { 'aria-label': 'More options' } });
        setIcon(moreBtn, 'more-horizontal');
        moreBtn.onclick = (e) => {
            e.stopPropagation();
            this.openNoteActionMenu(e, entry);
        };
    }

    private renderEntryMarkdown(bodyEl: HTMLElement, entry: JournalEntry): void {
        const cacheKey = `${entry.filePath}_${entry.modified}`;
        const cached = this.getCachedRenderedBody(cacheKey);

        if (cached) {
            bodyEl.empty();
            while (cached.firstChild) {
                bodyEl.appendChild(cached.firstChild);
            }
            this.attachInteractiveElements(bodyEl, entry);
        } else {
            void (async () => {
                const bodyText = await this.plugin.index.ensureEntryBodyLoaded(entry);
                if (this._streamComponent) {
                    bodyEl.empty();
                    await MarkdownRenderer.render(this.app, bodyText, bodyEl, entry.filePath, this._streamComponent);
                    // Cache clones of the children for instant re-render without extra wrapper divs
                    const cacheFrag = document.createElement('div');
                    for (let i = 0; i < bodyEl.childNodes.length; i++) {
                        cacheFrag.appendChild(bodyEl.childNodes[i].cloneNode(true));
                    }
                    this.setCachedRenderedBody(cacheKey, cacheFrag);
                    this.attachInteractiveElements(bodyEl, entry);
                }
            })();
        }
    }

    private attachInteractiveElements(container: HTMLElement, entry: JournalEntry): void {
        // 1. Task Checkboxes (Live In-Place Toggling with Optimistic Strike-Through)
        const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        checkboxes.forEach((cb, idx) => {
            cb.disabled = false;
            cb.addClass('pos-interactive-checkbox');

            const listItem = cb.closest('li');
            if (listItem) {
                listItem.toggleClass('is-checked', cb.checked);
                listItem.setAttribute('data-task', cb.checked ? 'x' : ' ');
            }

            const cleanLiText = listItem ? (listItem.textContent || '').replace(/^\[[ xX]\]\s*/, '').trim() : '';
            const matchedTask = entry.tasks ? (entry.tasks.find(t => t.title && cleanLiText && (cleanLiText.includes(t.title) || t.title.includes(cleanLiText))) || entry.tasks[idx]) : undefined;

            cb.onclick = async (e) => {
                e.stopPropagation();
                const isChecked = cb.checked;

                if (listItem) {
                    listItem.toggleClass('is-checked', isChecked);
                    listItem.setAttribute('data-task', isChecked ? 'x' : ' ');
                }

                if (matchedTask) {
                    matchedTask.completed = isChecked;
                }

                this.invalidateRenderCacheForFile(entry.filePath);
                this._taskPending++;
                try {
                    const lineIdx = matchedTask ? matchedTask.lineIndex : -1;
                    const taskTitle = matchedTask ? matchedTask.title : (cleanLiText || undefined);
                    await this.plugin.capture.toggleTaskInFile(entry.filePath, lineIdx, isChecked, taskTitle);
                } catch (err) {
                    cb.checked = !isChecked;
                    if (listItem) {
                        listItem.toggleClass('is-checked', !isChecked);
                        listItem.setAttribute('data-task', !isChecked ? 'x' : ' ');
                    }
                    new Notice('Failed to toggle task');
                } finally {
                    this._taskPending--;
                }
            };
        });

        // 2. Image Click to Zoom (Lightbox)
        const images = container.querySelectorAll<HTMLImageElement>('img');
        images.forEach(img => {
            img.addClass('pos-stream-zoomable-img');
            img.onclick = (e) => {
                e.stopPropagation();
                new ImageLightboxModal(this.app, { src: img.src, alt: img.alt, openerEl: img }).open();
            };
        });

        // 3. Privacy Shield click-to-reveal
        container.onclick = (e) => {
            if (this._isPrivacyShieldActive) {
                e.stopPropagation();
                container.classList.toggle('is-unblurred');
            }
        };
    }

    private renderInlineEditor(parent: HTMLElement, entry: JournalEntry): void {
        parent.empty();
        const textarea = parent.createEl('textarea', {
            cls: 'pos-inline-edit-textarea',
            value: entry.body
        });

        attachInlineTriggers(this.app, textarea, undefined, undefined, () => this.plugin.getContexts(), this.plugin.settings?.peopleFolder);
        attachMediaPasteHandler(this.app, textarea, () => this.plugin.settings?.attachmentsFolder || '000 Bin/Handumanan Attachments');

        const btnRow = parent.createDiv({ cls: 'pos-inline-edit-btns' });
        const saveBtn = btnRow.createEl('button', { cls: 'pos-action-btn pos-btn-primary', text: 'Save' });
        const cancelBtn = btnRow.createEl('button', { cls: 'pos-action-btn', text: 'Cancel' });

        saveBtn.onclick = async () => {
            const val = textarea.value.trim();
            if (!val) return;
            await this.plugin.capture.updateNoteContent(entry.filePath, val);
            entry.body = val;
            this.invalidateRenderCacheForFile(entry.filePath);
            this._editingEntryId = null;
            this.updateStreamOnly();
        };

        cancelBtn.onclick = () => {
            if (textarea.value.trim() !== entry.body.trim()) {
                if (!window.confirm('Discard unsaved edits?')) return;
            }
            this._editingEntryId = null;
            this.updateStreamOnly();
        };
    }

    private openNoteActionMenu(e: MouseEvent, entry: JournalEntry): void {
        const menu = new Menu();

        menu.addItem((item) => {
            item.setTitle('Open Note File')
                .setIcon('file-text')
                .onClick(async () => {
                    const file = this.app.vault.getAbstractFileByPath(entry.filePath);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf(false).openFile(file);
                    }
                });
        });

        menu.addItem((item) => {
            item.setTitle(entry.favorite ? 'Unstar Note' : 'Star Note')
                .setIcon('star')
                .onClick(async () => {
                    const newState = await this.plugin.capture.toggleNoteImportance(entry.filePath);
                    entry.favorite = newState;
                    entry.pinned = newState;
                    this.invalidateRenderCacheForFile(entry.filePath);
                    this.updateStreamOnly();
                    if (this._filterBarEl) this.renderFilterBar(this._filterBarEl);
                });
        });

        menu.addItem((item) => {
            item.setTitle('Edit Note')
                .setIcon('pencil')
                .onClick(() => {
                    this._editingEntryId = entry.id;
                    this.updateStreamOnly();
                });
        });

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle('Delete Note')
                .setIcon('trash-2')
                .setWarning(true)
                .onClick(async () => {
                    if (window.confirm('Move note to trash?')) {
                        await this.plugin.capture.deleteNote(entry.filePath);
                        this.updateStreamOnly();
                        new Notice('Note deleted');
                    }
                });
        });

        menu.showAtMouseEvent(e);
    }

    private updateStreamOnly(): void {
        if (!this._streamContainerEl) return;
        this.renderStream(this._streamContainerEl);
    }
}
