import { App, TFile, moment, normalizePath, parseYaml } from 'obsidian';
import { HandumananSettings, JournalEntry, JournalType } from '../types';

export class JournalEditConflictError extends Error {
    constructor() {
        super('This reflection changed elsewhere. Copy your edits, reload the entry, and try again.');
        this.name = 'JournalEditConflictError';
    }
}

export class CaptureService {
    private app: App;
    private settings: HandumananSettings;
    private static DRAFT_KEY = 'handumanan-journal-draft';
    private draftDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private fileMutations = new Map<string, Promise<void>>();

    constructor(app: App, settings: HandumananSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: HandumananSettings): void {
        this.settings = settings;
    }

    private getJournalRoot(): string {
        return this.settings.journalFolder?.trim() 
            || this.settings.captureFolder?.trim() 
            || '000 Bin/Handumanan';
    }

    /**
     * Creates an atomic journal entry partitioned in <journalFolder>/YYYY/MM/YYYY-MM-DD HH.mm.ss.md
     */
    async createJournalEntry(
        rawContent: string,
        options: {
            mood?: string;
            type?: JournalType;
            prompt?: string;
            isPrivate?: boolean;
            tags?: string[];
        } = {}
    ): Promise<TFile> {
        const now = moment();
        const year = now.format('YYYY');
        const month = now.format('MM');
        const timestampStr = now.format('YYYY-MM-DD HH.mm.ss');
        const isoTimestamp = now.format('YYYY-MM-DDTHH:mm:ss');
        const dayWikilink = `[[${now.format('YYYY-MM-DD')}]]`;

        const baseFolder = this.getJournalRoot();
        const targetDir = normalizePath(`${baseFolder}/${year}/${month}`);
        await this.ensureFolder(targetDir);

        // Pebble-Drop support: if text is empty but mood or prompt is specified, create presence micro-entry
        let entryBody = rawContent.trim();
        if (!entryBody && options.mood) {
            entryBody = `_Noted a moment of ${options.mood}._`;
        }

        // Extract inline tags (#theme)
        const inlineTags = this.extractInlineTags(entryBody);
        const combinedTags = Array.from(new Set([
            ...(options.tags ?? []).map(t => t.toLowerCase().replace(/^#/, '')),
            ...inlineTags.map(t => t.toLowerCase().replace(/^#/, ''))
        ]));

        // Extract people mentions (@person or [[person]])
        const peopleMentions = this.extractPeopleMentions(entryBody);

        // Format clean YAML frontmatter
        const frontmatterLines: string[] = [
            '---',
            `created: ${isoTimestamp}`,
            `modified: ${isoTimestamp}`,
            `day: "${dayWikilink}"`,
            `type: ${options.type || (options.isPrivate ? 'unburdening' : 'journal')}`,
        ];

        if (options.mood?.trim()) {
            frontmatterLines.push(`mood: ${JSON.stringify(options.mood.trim().toLowerCase())}`);
        }

        if (options.prompt?.trim()) {
            frontmatterLines.push(`prompt: ${JSON.stringify(options.prompt.trim())}`);
        }

        if (options.isPrivate) {
            frontmatterLines.push('private: true');
        }

        if (peopleMentions.length > 0) {
            frontmatterLines.push('people:');
            for (const person of peopleMentions) {
                frontmatterLines.push(`  - "[[${person}]]"`);
            }
        }

        if (combinedTags.length > 0) {
            frontmatterLines.push('tags:');
            for (const tag of combinedTags) {
                frontmatterLines.push(`  - ${JSON.stringify(tag)}`);
            }
        }

        frontmatterLines.push('---');
        frontmatterLines.push('');

        const fileContent = `${frontmatterLines.join('\n')}${entryBody}\n`;

        // Generate unique file path with collision protection (pure in-memory check)
        let filePath = normalizePath(`${targetDir}/${timestampStr}.md`);
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(filePath)) {
            filePath = normalizePath(`${targetDir}/${timestampStr}_${counter}.md`);
            counter++;
        }

        const newFile = await this.app.vault.create(filePath, fileContent);
        this.clearDraft();
        return newFile;
    }

    /**
     * Backward-compatible alias for existing views / commands
     */
    async createCaptureNote(
        rawContent: string,
        area: string = '',
        tags: string[] = []
    ): Promise<TFile> {
        return this.createJournalEntry(rawContent, {
            tags: area ? [area, ...tags] : tags,
        });
    }

    private async withFileMutation<T>(filePath: string, mutation: () => Promise<T>): Promise<T> {
        const previous = this.fileMutations.get(filePath) ?? Promise.resolve();
        const pending = previous.then(mutation);
        const settled = pending.then(() => undefined, () => undefined);
        this.fileMutations.set(filePath, settled);
        try {
            return await pending;
        } finally {
            if (this.fileMutations.get(filePath) === settled) this.fileMutations.delete(filePath);
        }
    }

    private setFrontmatterField(header: string, key: string, value: string, nl: string): string {
        const line = new RegExp(`^${key}:[^\\r\\n]*`, 'm');
        if (line.test(header)) return header.replace(line, `${key}: ${value}`);
        return `${header}${header ? nl : ''}${key}: ${value}`;
    }

    private setFrontmatterTags(header: string, tags: string[], nl: string): string {
        const value = `tags: ${JSON.stringify(tags)}`;
        const lines = header.split(/\r?\n/);
        const start = lines.findIndex(line => /^tags:/.test(line));
        if (start < 0) return `${header}${header ? nl : ''}${value}`;
        let end = start + 1;
        while (end < lines.length && (!lines[end].trim() || /^[ \t]/.test(lines[end]))) end++;
        lines.splice(start, end - start, value);
        return lines.join(nl);
    }

    async updateNoteContent(
        filePath: string,
        newBody: string,
        area?: string,
        tags?: string[],
        expectedBody?: string,
    ): Promise<void> {
        await this.withFileMutation(filePath, async () => {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);

            const nowIso = moment().format('YYYY-MM-DDTHH:mm:ss');
            await this.app.vault.process(file, (raw) => {
                const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
                const currentBody = (fmMatch ? raw.slice(fmMatch[0].length) : raw).trim();
                if (expectedBody !== undefined && currentBody !== expectedBody.trim()) {
                    throw new JournalEditConflictError();
                }

                const nl = raw.includes('\r\n') ? '\r\n' : '\n';
                let header = fmMatch ? fmMatch[1] : '';
                const parsed = header ? parseYaml(header) ?? {} : {};
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error(`Invalid journal frontmatter: ${filePath}`);
                }
                header = this.setFrontmatterField(header, 'modified', nowIso, nl);
                if (!parsed.created) header = this.setFrontmatterField(header, 'created', nowIso, nl);
                if (!parsed.type) header = this.setFrontmatterField(header, 'type', 'journal', nl);
                if (tags?.length) {
                    const existing = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
                    const merged = Array.from(new Set([
                        ...existing,
                        ...tags.map(tag => tag.toLowerCase().replace(/^#/, '')),
                    ]));
                    header = this.setFrontmatterTags(header, merged, nl);
                }
                return `---${nl}${header}${nl}---${nl}${nl}${newBody.trim()}${nl}`;
            });
        });
    }

    /**
     * Toggles favorite (keepsake / star) on an entry using processFrontMatter.
     */
    async toggleFavorite(filePath: string): Promise<boolean> {
        return this.withFileMutation(filePath, async () => {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);
            let isNowFavorite = false;
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                isNowFavorite = !Boolean(fm.favorite);
                fm.favorite = isNowFavorite;
                fm.modified = moment().format('YYYY-MM-DDTHH:mm:ss');
            });
            return isNowFavorite;
        });
    }

    /**
     * Sends a note safely to trash using Obsidian native trash
     */
    async deleteNote(filePath: string): Promise<void> {
        await this.withFileMutation(filePath, async () => {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);
            await this.app.vault.trash(file, true);
        });
    }

    /**
     * Weaves multiple journal entries into a synthesized essay/reflection.
     * Preserves original source files by default for emotional safety, tagging them with synthesized provenance.
     */
    async mergeNotes(
        sourceFilePaths: string[],
        targetFilePath?: string,
        newTitle?: string,
        trashSourceFiles: boolean = false
    ): Promise<TFile> {
        const contents: string[] = [];
        const sourceFiles: TFile[] = [];

        for (const path of sourceFilePaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                sourceFiles.push(file);
                const raw = await this.app.vault.read(file);
                // Strip frontmatter safely
                const body = raw.replace(/^---[\s\S]*?---\r?\n*/, '').trim();
                if (body) {
                    contents.push(body);
                }
            }
        }

        const mergedBody = contents.join('\n\n---\n\n');
        let destinationFile: TFile;

        // Build provenance appendix
        const provenanceList = sourceFiles.map(f => `- [[${f.basename}]]`).join('\n');
        const provenanceBlock = `\n\n---\n### 🧵 Woven Memories\n${provenanceList}\n`;

        if (targetFilePath) {
            const targetFile = this.app.vault.getAbstractFileByPath(targetFilePath);
            if (targetFile instanceof TFile) {
                await this.withFileMutation(targetFilePath, () => this.app.vault.process(targetFile, (existing) => {
                    const newline = existing.includes('\r\n') ? '\r\n' : '\n';
                    return `${existing.trim()}${newline}${newline}---${newline}${newline}${mergedBody}${provenanceBlock}`;
                }));
                destinationFile = targetFile;
            } else {
                throw new Error(`Target file not found: ${targetFilePath}`);
            }
        } else {
            const title = newTitle?.trim() || `Journal Reflection ${moment().format('YYYY-MM-DD HH.mm')}`;
            const targetFolder = this.settings.newNoteFolder || this.getJournalRoot();
            await this.ensureFolder(targetFolder);
            const path = normalizePath(`${targetFolder}/${title}.md`);
            destinationFile = await this.app.vault.create(path, `# ${title}\n\n${mergedBody}${provenanceBlock}`);
        }

        // If not trashing, mark source files as synthesized with backlink to destination
        for (const file of sourceFiles) {
            if (file.path !== destinationFile.path) {
                if (trashSourceFiles) {
                    try {
                        await this.withFileMutation(file.path, () => this.app.vault.trash(file, true));
                    } catch (e) {
                        console.warn('[CaptureService] Could not trash file:', file.path);
                    }
                } else {
                    try {
                        await this.withFileMutation(file.path, () => this.app.fileManager.processFrontMatter(file, (fm) => {
                            fm.synthesized = true;
                            fm.wovenInto = `[[${destinationFile.basename}]]`;
                        }));
                    } catch (e) {
                        console.warn('[CaptureService] Could not update source provenance:', file.path);
                    }
                }
            }
        }

        return destinationFile;
    }

    private getDraftKey(): string {
        const vaultName = this.app.vault.getName() || 'default';
        return `handumanan-journal-draft-${vaultName}`;
    }

    saveDraft(text: string): void {
        if (this.draftDebounceTimer) {
            clearTimeout(this.draftDebounceTimer);
        }
        this.draftDebounceTimer = setTimeout(() => {
            this.draftDebounceTimer = null;
            try {
                const key = this.getDraftKey();
                if (!text || !text.trim()) {
                    localStorage.removeItem(key);
                } else {
                    localStorage.setItem(key, text);
                }
            } catch (e) {
                console.warn('[CaptureService] Could not save draft', e);
            }
        }, 300);
    }

    getDraft(): string {
        try {
            const key = this.getDraftKey();
            return localStorage.getItem(key) || localStorage.getItem(CaptureService.DRAFT_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    clearDraft(): void {
        if (this.draftDebounceTimer) {
            clearTimeout(this.draftDebounceTimer);
            this.draftDebounceTimer = null;
        }
        try {
            localStorage.removeItem(this.getDraftKey());
            localStorage.removeItem(CaptureService.DRAFT_KEY);
        } catch (e) {}
    }

    private extractInlineTags(text: string): string[] {
        const matches = text.match(/#[a-zA-Z0-9_\-\/]+/g);
        if (!matches) return [];
        return matches.map(t => t.substring(1));
    }

    private extractPeopleMentions(text: string): string[] {
        const people: string[] = [];
        // Match @Person or [[Person]]
        const atMatches = text.match(/@([a-zA-Z0-9_-]+)/g);
        if (atMatches) {
            for (const m of atMatches) people.push(m.slice(1));
        }
        const wikiMatches = text.match(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g);
        if (wikiMatches) {
            for (const w of wikiMatches) {
                const clean = w.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
                if (clean) people.push(clean);
            }
        }
        return Array.from(new Set(people));
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const normalized = normalizePath(folderPath);
        if (normalized === '' || normalized === '/') return;
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (!existing) {
            try {
                await this.app.vault.createFolder(normalized);
            } catch (e: any) {
                if (!String(e?.message || '').includes('already exists')) {
                    throw e;
                }
            }
        }
    }
}
