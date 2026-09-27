import { App, TFile, moment, normalizePath } from 'obsidian';
import { HandumananSettings, JournalEntry, JournalType } from '../types';

export class CaptureService {
    private app: App;
    private settings: HandumananSettings;
    private static DRAFT_KEY = 'handumanan-journal-draft';
    private draftDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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

    /**
     * Updates an existing journal entry atomically using Obsidian's processFrontMatter.
     */
    async updateNoteContent(filePath: string, newBody: string, area?: string, tags?: string[]): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const nowIso = moment().format('YYYY-MM-DDTHH:mm:ss');

        // Safe atomic frontmatter update via official API
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm.modified = nowIso;
            if (!fm.created) fm.created = nowIso;
            if (!fm.type) fm.type = 'journal';
            if (tags && tags.length > 0) {
                const cleanTags = tags.map(t => t.toLowerCase().replace(/^#/, ''));
                const existing = Array.isArray(fm.tags) ? fm.tags : [];
                fm.tags = Array.from(new Set([...existing, ...cleanTags]));
            }
        });

        // Safely splice new body while preserving frontmatter header
        const raw = await this.app.vault.read(file);
        const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const frontmatterHeader = fmMatch ? fmMatch[0] : '';
        const isCrlf = raw.includes('\r\n');
        const nl = isCrlf ? '\r\n' : '\n';
        const finalContent = `${frontmatterHeader.trim()}${nl}${nl}${newBody.trim()}${nl}`;
        await this.app.vault.modify(file, finalContent);
    }

    /**
     * Toggles favorite (keepsake / star) on an entry using processFrontMatter.
     */
    async toggleFavorite(filePath: string): Promise<boolean> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return false;

        let isNowFavorite = false;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            isNowFavorite = !Boolean(fm.favorite);
            fm.favorite = isNowFavorite;
            fm.modified = moment().format('YYYY-MM-DDTHH:mm:ss');
        });

        return isNowFavorite;
    }

    /**
     * Sends a note safely to trash using Obsidian native trash
     */
    async deleteNote(filePath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            await this.app.vault.trash(file, true);
        }
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
                await this.app.vault.process(targetFile, (existing) => {
                    const isCrlf = existing.includes('\r\n');
                    const newline = isCrlf ? '\r\n' : '\n';
                    return `${existing.trim()}${newline}${newline}---${newline}${newline}${mergedBody}${provenanceBlock}`;
                });
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
                        await this.app.vault.trash(file, true);
                    } catch (e) {
                        console.warn('[CaptureService] Could not trash file:', file.path);
                    }
                } else {
                    try {
                        await this.app.fileManager.processFrontMatter(file, (fm) => {
                            fm.synthesized = true;
                            fm.wovenInto = `[[${destinationFile.basename}]]`;
                        });
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
