import { App, TFile } from 'obsidian';
import { VIEW_TYPE_DESKTOP_HUB } from '../constants';
import type { HandumananSettings } from '../types';
import { DesktopHubView } from '../views/DesktopHubView';
import type { IndexService } from '../services/IndexService';

export type RefreshScope = 'all' | 'journal';

const JOURNAL_REFRESH_DEBOUNCE_MS = 250;
const DEFAULT_REFRESH_DEBOUNCE_MS = 400;

export class RefreshCoordinator {
    private _indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private _reindexCooldown: Map<string, number> = new Map();
    private _suppressNotifyRefreshUntil: number = 0;
    private _pendingRefreshScope: RefreshScope | null = null;

    constructor(
        private app: App,
        private settings: HandumananSettings,
        private index: IndexService,
    ) {}

    updateSettings(settings: HandumananSettings): void {
        this.settings = settings;
    }

    suppressNotifyRefresh(ms = 1200): void {
        const until = Date.now() + ms;
        if (until > this._suppressNotifyRefreshUntil) this._suppressNotifyRefreshUntil = until;
    }

    bumpReindexCooldown(filePath: string): void {
        this._reindexCooldown.set(filePath, Date.now());
    }

    async reindexFile(file: TFile, isMetadataChange = false): Promise<void> {
        const now = Date.now();
        const last = this._reindexCooldown.get(file.path) ?? 0;
        if (!isMetadataChange && (now - last < 300)) return;
        this._reindexCooldown.set(file.path, now);

        if (this.index.isJournalFile(file.path)) {
            await this.index.indexJournalFile(file);
            this.notifyRefresh('journal');
        }
    }

    notifyRefresh(scope: RefreshScope = 'all'): void {
        this._pendingRefreshScope = this.mergeRefreshScope(this._pendingRefreshScope, scope);
        if (this._indexDebounceTimer) clearTimeout(this._indexDebounceTimer);

        if (Date.now() < this._suppressNotifyRefreshUntil) {
            const deferMs = Math.max(50, this._suppressNotifyRefreshUntil - Date.now() + 50);
            this._indexDebounceTimer = setTimeout(() => {
                this._indexDebounceTimer = null;
                this._dispatchRefresh();
            }, deferMs);
            return;
        }

        const debounceMs = this._pendingRefreshScope === 'journal'
            ? JOURNAL_REFRESH_DEBOUNCE_MS
            : DEFAULT_REFRESH_DEBOUNCE_MS;

        this._indexDebounceTimer = setTimeout(() => {
            this._indexDebounceTimer = null;
            this._dispatchRefresh();
        }, debounceMs);
    }

    private _dispatchRefresh(): void {
        if (Date.now() < this._suppressNotifyRefreshUntil) {
            const deferMs = Math.max(50, this._suppressNotifyRefreshUntil - Date.now() + 50);
            this._indexDebounceTimer = setTimeout(() => {
                this._indexDebounceTimer = null;
                this._dispatchRefresh();
            }, deferMs);
            return;
        }

        this._pendingRefreshScope = null;

        const hubLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DESKTOP_HUB);
        for (const leaf of hubLeaves) {
            const view = leaf.view as DesktopHubView;
            if (view && typeof view.refreshAll === 'function') {
                view.refreshAll();
            }
        }
    }

    private mergeRefreshScope(current: RefreshScope | null, next: RefreshScope): RefreshScope {
        if (!current || current === next) return next;
        return 'all';
    }

    onunload(): void {
        if (this._indexDebounceTimer) {
            clearTimeout(this._indexDebounceTimer);
            this._indexDebounceTimer = null;
        }
        this._pendingRefreshScope = null;
        this._reindexCooldown.clear();
    }
}
