import { App, TFile, moment } from 'obsidian';
import { HandumananSettings, JournalEntry, JournalType } from '../types';
import { extractWikiLinks } from '../utils/wikilinks';
import { normalizeVaultRelativePath } from '../utils/vaultFiles';

export class IndexService {
    app: App;
    settings: HandumananSettings;

    // Memory Indices
    journalIndex: Map<string, JournalEntry> = new Map();
    // Compatibility alias
    captureIndex: Map<string, JournalEntry> = this.journalIndex;

    private _entriesByDay: Map<string, Set<string>> = new Map();
    private _entriesByPerson: Map<string, Set<string>> = new Map();
    private _entriesByMood: Map<string, Set<string>> = new Map();

    private _sortedEntriesCache: JournalEntry[] = [];
    private _isSortedDirty = true;
    private _indexEpoch = 0;
    private _nextFileVersion = 0;
    private _fileVersions = new Map<string, number>();
    private _lastResurfacedPath: string | null = null;
    private _loadedBodies = new WeakSet<JournalEntry>();

    constructor(app: App, settings: HandumananSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: HandumananSettings): void {
        this.settings = settings;
        this._isSortedDirty = true;
    }

    private getJournalFolder(): string {
        return (this.settings.journalFolder || this.settings.captureFolder || '000 Bin/Handumanan').trim();
    }

    private normalizeVaultPath(path: string): string {
        return normalizeVaultRelativePath(path, 'path');
    }

    private pathIsInFolder(path: string, folder: string): boolean {
        const normalizedPath = this.normalizeVaultPath(path).toLowerCase();
        const normalizedFolder = this.normalizeVaultPath(folder).toLowerCase();
        if (normalizedFolder === '') return true;
        return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
    }

    isCaptureFile(filePath: string): boolean {
        const journalFolder = this.getJournalFolder();
        return this.pathIsInFolder(filePath, journalFolder) 
            && filePath.toLowerCase().endsWith('.md') 
            && !filePath.toLowerCase().includes('/trash/');
    }

    isJournalFile(filePath: string): boolean {
        return this.isCaptureFile(filePath);
    }

    resetAllIndices(): void {
        this._indexEpoch++;
        this._fileVersions.clear();
        this._lastResurfacedPath = null;
        this.journalIndex.clear();
        this._entriesByDay.clear();
        this._entriesByPerson.clear();
        this._entriesByMood.clear();
        this._sortedEntriesCache = [];
        this._isSortedDirty = true;
    }

    /**
     * Fast in-memory startup indexing utilizing Obsidian's metadataCache.
     * Avoids sequential disk reads for 10k+ notes.
     */
    async buildIndices(): Promise<void> {
        this.resetAllIndices();
        const epoch = this._indexEpoch;
        const files = this.app.vault.getMarkdownFiles().filter(f => this.isCaptureFile(f.path));
        const uncached: TFile[] = [];

        for (const file of files) {
            if (epoch !== this._indexEpoch) return;
            if (this.app.vault.getAbstractFileByPath(file.path) !== file) continue;
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter) {
                if (!this._fileVersions.has(file.path)) this.indexFromCache(file, cache);
            } else if (!this._fileVersions.has(file.path)) {
                uncached.push(file);
            }
        }
        for (let i = 0; i < uncached.length; i += 16) {
            if (epoch !== this._indexEpoch) return;
            await Promise.all(uncached.slice(i, i + 16).map(file => this.indexJournalFile(file)));
        }
        this._isSortedDirty = true;
    }

    private indexFromCache(file: TFile, cache: import('obsidian').CachedMetadata): void {
        const fm = cache.frontmatter || {};
        const createdStr = String(fm.created || moment(file.stat.ctime).format('YYYY-MM-DD HH:mm:ss'));
        const modifiedStr = String(fm.modified || moment(file.stat.mtime).format('YYYY-MM-DD HH:mm:ss'));
        const createdAtMs = moment(createdStr).isValid() ? moment(createdStr).valueOf() : file.stat.ctime;

        let dayStr = '';
        if (fm.day) {
            const m = String(fm.day).match(/\d{4}-\d{2}-\d{2}/);
            if (m) dayStr = m[0];
        }
        if (!dayStr) {
            dayStr = moment(createdAtMs).format('YYYY-MM-DD');
        }

        let tags: string[] = [];
        if (Array.isArray(fm.tags)) {
            tags = fm.tags.map((t: string) => String(t).replace(/^#/, ''));
        } else if (typeof fm.tags === 'string') {
            tags = fm.tags.split(',').map((t: string) => t.trim().replace(/^#/, ''));
        }
        if (cache.tags) {
            for (const t of cache.tags) {
                tags.push(t.tag.replace(/^#/, ''));
            }
        }
        tags = Array.from(new Set(tags.map(t => t.toLowerCase())));

        let people: string[] = [];
        if (Array.isArray(fm.people)) {
            people = fm.people.map((p: string) => String(p).replace(/^\[\[|\]\]$/g, ''));
        }
        if (cache.links) {
            for (const l of cache.links) {
                if (l.original.startsWith('@')) {
                    people.push(l.link);
                }
            }
        }
        people = Array.from(new Set(people));

        const entry: JournalEntry = {
            id: file.path,
            filePath: file.path,
            title: fm.title || file.basename,
            created: createdStr,
            modified: modifiedStr,
            createdAtMs,
            day: dayStr,
            type: (fm.type as JournalType) || 'journal',
            mood: fm.mood ? String(fm.mood).toLowerCase() : undefined,
            prompt: fm.prompt ? String(fm.prompt) : undefined,
            private: Boolean(fm.private),
            favorite: Boolean(fm.favorite),
            pinned: Boolean(fm.pinned),
            tags,
            people,
            places: Array.isArray(fm.places) ? fm.places : [],
            photos: [],
            body: '', // Lazy loaded on demand
            allDates: [dayStr],
            wikilinks: cache.links ? cache.links.map(l => l.link) : [],
            wordCount: 0,
            readingTimeMin: 1,
            synthesized: Boolean(fm.synthesized),
        };

        this.addEntryToIndices(file.path, entry);
    }

    private addEntryToIndices(filePath: string, entry: JournalEntry): void {
        this.journalIndex.set(filePath, entry);

        if (entry.day) {
            if (!this._entriesByDay.has(entry.day)) {
                this._entriesByDay.set(entry.day, new Set());
            }
            this._entriesByDay.get(entry.day)!.add(filePath);
        }

        for (const person of entry.people || []) {
            const normPerson = person.toLowerCase().replace(/^\[\[|\]\]$/g, '');
            if (!this._entriesByPerson.has(normPerson)) {
                this._entriesByPerson.set(normPerson, new Set());
            }
            this._entriesByPerson.get(normPerson)!.add(filePath);
        }

        if (entry.mood) {
            const normMood = entry.mood.toLowerCase();
            if (!this._entriesByMood.has(normMood)) {
                this._entriesByMood.set(normMood, new Set());
            }
            this._entriesByMood.get(normMood)!.add(filePath);
        }

        this._isSortedDirty = true;
    }

    async indexJournalFile(file: TFile): Promise<void> {
        const epoch = this._indexEpoch;
        const version = ++this._nextFileVersion;
        this._fileVersions.set(file.path, version);
        try {
            const content = await this.app.vault.cachedRead(file);
            const entry = this.parseJournalFileContent(file, content);
            if (epoch !== this._indexEpoch || this._fileVersions.get(file.path) !== version
                || this.app.vault.getAbstractFileByPath(file.path) !== file) return;
            this.removeEntryFromIndices(file.path);
            this.addEntryToIndices(file.path, entry);
        } catch (e) {
            console.warn('[IndexService] Could not index journal file:', file.path, e);
        }
    }

    async ensureEntryBodyLoaded(entry: JournalEntry): Promise<string> {
        if (entry.body || this._loadedBodies.has(entry)) return entry.body;
        const file = this.app.vault.getAbstractFileByPath(entry.filePath);
        if (!(file instanceof TFile)) throw new Error(`Reflection not found: ${entry.filePath}`);
        const raw = await this.app.vault.cachedRead(file);
        const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        entry.body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();
        entry.wordCount = entry.body ? entry.body.split(/\s+/).length : 0;
        entry.readingTimeMin = Math.max(1, Math.ceil(entry.wordCount / 200));
        this._loadedBodies.add(entry);
        return entry.body;
    }

    private removeEntryFromIndices(filePath: string): void {
        const entry = this.journalIndex.get(filePath);
        if (!entry) return;
        this.journalIndex.delete(filePath);
        const remove = (index: Map<string, Set<string>>, key: string) => {
            const set = index.get(key);
            if (!set) return;
            set.delete(filePath);
            if (!set.size) index.delete(key);
        };
        if (entry.day) remove(this._entriesByDay, entry.day);
        for (const person of entry.people ?? []) {
            remove(this._entriesByPerson, person.toLowerCase().replace(/^\[\[|\]\]$/g, ''));
        }
        if (entry.mood) remove(this._entriesByMood, entry.mood.toLowerCase());
        this._isSortedDirty = true;
    }

    removeCaptureFile(filePath: string): void {
        this._fileVersions.set(filePath, ++this._nextFileVersion);
        this.removeEntryFromIndices(filePath);
    }

    handleRename(oldPath: string, newPath: string): void {
        this.removeCaptureFile(oldPath);
        const newFile = this.app.vault.getAbstractFileByPath(newPath);
        if (newFile instanceof TFile && this.isJournalFile(newPath)) {
            void this.indexJournalFile(newFile);
        }
    }

    private parseJournalFileContent(file: TFile, content: string): JournalEntry {
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();

        const frontmatter: Record<string, any> = {};
        if (fmMatch) {
            const lines = fmMatch[1].split(/\r?\n/);
            let currentKey: string | null = null;
            for (const line of lines) {
                const kv = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
                if (kv) {
                    const key = kv[1];
                    const val = kv[2].trim().replace(/^['"]|['"]$/g, '');
                    currentKey = null;
                    if (!val) {
                        frontmatter[key] = [];
                        currentKey = key;
                    } else if (val.toLowerCase() === 'true') {
                        frontmatter[key] = true;
                    } else if (val.toLowerCase() === 'false') {
                        frontmatter[key] = false;
                    } else {
                        frontmatter[key] = val;
                    }
                } else if (currentKey) {
                    const item = line.match(/^\s*-\s*(.*)$/);
                    if (item) {
                        const itemVal = item[1].trim().replace(/^['"]|['"]$/g, '');
                        if (Array.isArray(frontmatter[currentKey])) {
                            frontmatter[currentKey].push(itemVal);
                        }
                    }
                }
            }
        }

        const createdStr = String(frontmatter.created || moment(file.stat.ctime).format('YYYY-MM-DD HH:mm:ss'));
        const modifiedStr = String(frontmatter.modified || moment(file.stat.mtime).format('YYYY-MM-DD HH:mm:ss'));
        const createdAtMs = moment(createdStr).isValid() ? moment(createdStr).valueOf() : file.stat.ctime;

        let dayStr = '';
        if (frontmatter.day) {
            const m = String(frontmatter.day).match(/\d{4}-\d{2}-\d{2}/);
            if (m) dayStr = m[0];
        }
        if (!dayStr) {
            dayStr = moment(createdAtMs).format('YYYY-MM-DD');
        }

        let tags: string[] = [];
        if (Array.isArray(frontmatter.tags)) {
            tags = frontmatter.tags.map((t: string) => String(t).replace(/^#/, ''));
        } else if (typeof frontmatter.tags === 'string') {
            tags = frontmatter.tags.split(',').map((t: string) => t.trim().replace(/^#/, ''));
        }
        const inlineTags = (body.match(/#[a-zA-Z0-9_\-\/]+/g) || []).map(t => t.slice(1));
        tags = Array.from(new Set([...tags, ...inlineTags].map(t => t.toLowerCase())));

        let people: string[] = [];
        if (Array.isArray(frontmatter.people)) {
            people = frontmatter.people.map((p: string) => String(p).replace(/^\[\[|\]\]$/g, ''));
        }
        const inlineAtPeople = (body.match(/@([a-zA-Z0-9_-]+)/g) || []).map(p => p.slice(1));
        people = Array.from(new Set([...people, ...inlineAtPeople]));

        const wikilinks = extractWikiLinks(body);
        const dateRegex = /\b\d{4}-\d{2}-\d{2}\b/g;
        const allDates = Array.from(new Set([...(body.match(dateRegex) || [])]));

        const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
        const readingTimeMin = Math.max(1, Math.ceil(wordCount / 200));

        const entry: JournalEntry = {
            id: file.path,
            filePath: file.path,
            title: frontmatter.title || file.basename,
            created: createdStr,
            modified: modifiedStr,
            createdAtMs,
            day: dayStr,
            type: (frontmatter.type as JournalType) || 'journal',
            mood: frontmatter.mood ? String(frontmatter.mood).toLowerCase() : undefined,
            prompt: frontmatter.prompt ? String(frontmatter.prompt) : undefined,
            private: Boolean(frontmatter.private),
            favorite: Boolean(frontmatter.favorite),
            pinned: Boolean(frontmatter.pinned),
            tags,
            people,
            places: Array.isArray(frontmatter.places) ? frontmatter.places : [],
            photos: [],
            body,
            allDates,
            wikilinks,
            wordCount,
            readingTimeMin,
            synthesized: Boolean(frontmatter.synthesized),
        };

        return entry;
    }

    /**
     * Returns all entries sorted by creation timestamp descending.
     * Cached in O(1) time until index changes.
     */
    getAllCaptures(): JournalEntry[] {
        if (this._isSortedDirty) {
            this._sortedEntriesCache = Array.from(this.journalIndex.values()).sort(
                (a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
            );
            this._isSortedDirty = false;
        }
        return this._sortedEntriesCache;
    }

    getAllJournalEntries(): JournalEntry[] {
        return this.getAllCaptures();
    }

    /**
     * Anniversary recall across past years. Excludes private/unburdening notes for emotional safety.
     */
    getOnThisDayEntries(): JournalEntry[] {
        const today = moment();
        const currentMonthDay = today.format('MM-DD');
        const currentYear = today.format('YYYY');

        return this.getAllCaptures().filter(entry => {
            if (entry.private || entry.type === 'unburdening' || entry.tags?.includes('unburdening')) return false;
            const entryMoment = moment(entry.createdAtMs);
            return entryMoment.format('MM-DD') === currentMonthDay && entryMoment.format('YYYY') !== currentYear;
        });
    }

    /**
     * Safe random serendipity memory resurfacing (excludes private or unburdening grief).
     */
    getRandomMemory(): JournalEntry | null {
        const today = moment().format('YYYY-MM-DD');
        const eligible = this.getAllCaptures().filter(e =>
            !e.private && e.type !== 'unburdening'
            && !e.tags?.includes('unburdening') && e.day < today
        );
        if (!eligible.length) return null;

        const anniversaryPaths = new Set(this.getOnThisDayEntries().map(entry => entry.filePath));
        const anniversaries = eligible.filter(entry => anniversaryPaths.has(entry.filePath));
        const pool = anniversaries.length ? anniversaries : eligible;
        const candidates = pool.length > 1
            ? pool.filter(entry => entry.filePath !== this._lastResurfacedPath)
            : pool;
        const totalWeight = candidates.reduce((sum, entry) => sum + (entry.favorite ? 2 : 1), 0);
        let ticket = Math.random() * totalWeight;
        for (const entry of candidates) {
            ticket -= entry.favorite ? 2 : 1;
            if (ticket < 0) {
                this._lastResurfacedPath = entry.filePath;
                return entry;
            }
        }
        const last = candidates[candidates.length - 1];
        this._lastResurfacedPath = last.filePath;
        return last;
    }

    getTodayCapturesCount(): number {
        const todayStr = moment().format('YYYY-MM-DD');
        return this._entriesByDay.get(todayStr)?.size ?? 0;
    }

    getFavorites(): JournalEntry[] {
        return this.getAllCaptures().filter(e => e.favorite);
    }
}
