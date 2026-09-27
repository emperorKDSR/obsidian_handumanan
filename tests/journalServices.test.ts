import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, TFile as ObsidianFile } from 'obsidian';
import { CaptureService, JournalEditConflictError } from '../src/services/CaptureService';
import { IndexService } from '../src/services/IndexService';
import type { HandumananSettings } from '../src/types';
import { TFile, moment, parseYaml } from './obsidianMock';

const folder = '000 Bin/Handumanan';
const settings = { journalFolder: folder } as HandumananSettings;
const path = `${folder}/2025/09/2025-09-27 10.00.00.md`;

function content(body: string, extra = ''): string {
    return `---\ncreated: 2025-09-27T10:00:00\nmodified: 2025-09-27T10:00:00\ntype: journal\n${extra}---\n\n${body}\n`;
}

function fixture() {
    const files = new Map<string, string>();
    const fileObjects = new Map<string, TFile>();
    const file = new TFile(path);
    fileObjects.set(path, file);
    files.set(path, content('First entry'));
    const vault = {
        getAbstractFileByPath: vi.fn((filePath: string) => fileObjects.get(filePath) ?? null),
        getMarkdownFiles: vi.fn(() => [...fileObjects.values()]),
        cachedRead: vi.fn(async (item: TFile) => files.get(item.path) ?? ''),
        read: vi.fn(async (item: TFile) => files.get(item.path) ?? ''),
        process: vi.fn(async (item: TFile, mutate: (value: string) => string) => {
            const next = mutate(files.get(item.path) ?? '');
            files.set(item.path, next);
            return next;
        }),
        trash: vi.fn(async (item: TFile) => {
            files.delete(item.path);
            fileObjects.delete(item.path);
        }),
    };
    const app = {
        vault,
        metadataCache: { getFileCache: vi.fn(() => null) },
        fileManager: {
            processFrontMatter: vi.fn(async (item: TFile, mutate: (fm: Record<string, unknown>) => void) => {
                await vault.process(item, raw => {
                    const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
                    const fm = parseYaml(match?.[1] ?? '');
                    mutate(fm);
                    const header = Object.entries(fm)
                        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
                    return `---\n${header}\n---\n${match ? raw.slice(match[0].length) : raw}`;
                });
            }),
        },
    } as unknown as App;
    return { app, vault, files, fileObjects, file };
}

describe('journal persistence', () => {
    it('updates body and metadata in one process while preserving unrelated YAML and comments', async () => {
        const { app, vault, files } = fixture();
        files.set(path, content('First entry', 'custom: keep\n# personal annotation\n'));
        await new CaptureService(app, settings).updateNoteContent(path, 'Edited entry', undefined, undefined, 'First entry');

        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(files.get(path)).toContain('custom: keep\n# personal annotation\n');
        expect(files.get(path)).toMatch(/modified: \d{4}-\d{2}-\d{2}T/);
        expect(files.get(path)).toContain('---\n\nEdited entry\n');
    });

    it('refuses to overwrite an externally changed body and retains the current file', async () => {
        const { app, files } = fixture();
        files.set(path, content('Changed in Obsidian'));
        await expect(new CaptureService(app, settings).updateNoteContent(
            path, 'Unsubmitted draft', undefined, undefined, 'First entry',
        )).rejects.toBeInstanceOf(JournalEditConflictError);
        expect(files.get(path)).toContain('Changed in Obsidian');
        expect(files.get(path)).not.toContain('Unsubmitted draft');
    });

    it('allows retry after a conflict without leaving the file mutation queue blocked', async () => {
        const { app, files } = fixture();
        const service = new CaptureService(app, settings);
        await expect(service.updateNoteContent(path, 'Draft', undefined, undefined, 'Outdated')).rejects
            .toBeInstanceOf(JournalEditConflictError);
        await service.updateNoteContent(path, 'Draft', undefined, undefined, 'First entry');
        expect(files.get(path)).toContain('Draft');
    });

    it('preserves line endings and merges YAML list tags without orphaning list entries', async () => {
        const { app, files } = fixture();
        files.set(path, content('First entry', 'tags:\n  - existing\ncustom: yes\n').replace(/\n/g, '\r\n'));
        await new CaptureService(app, settings).updateNoteContent(
            path, 'Edited entry', undefined, ['new'], 'First entry',
        );
        expect(files.get(path)).toMatch(/tags: \["existing","new"\]\r\ncustom: yes/);
        expect(files.get(path)).not.toMatch(/(?<!\r)\n/);
    });

    it('serializes a body update and keepsake change on the same file', async () => {
        const { app, files } = fixture();
        const service = new CaptureService(app, settings);
        const edit = service.updateNoteContent(path, 'Second entry', undefined, undefined, 'First entry');
        const favorite = service.toggleFavorite(path);
        await Promise.all([edit, favorite]);
        expect(files.get(path)).toContain('Second entry');
        expect(files.get(path)).toContain('favorite: true');
    });

    it('rejects a duplicate edit instead of overwriting the first submitted body', async () => {
        const { app, files } = fixture();
        const service = new CaptureService(app, settings);
        const first = service.updateNoteContent(path, 'First save', undefined, undefined, 'First entry');
        const duplicate = service.updateNoteContent(path, 'Second save', undefined, undefined, 'First entry');
        await first;
        await expect(duplicate).rejects.toBeInstanceOf(JournalEditConflictError);
        expect(files.get(path)).toContain('First save');
        expect(files.get(path)).not.toContain('Second save');
    });
});

describe('journal index consistency', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('ignores an older read completing after a newer read', async () => {
        const { app, vault, file } = fixture();
        const resolves: Array<(value: string) => void> = [];
        vault.cachedRead.mockImplementation(() => new Promise(resolve => resolves.push(resolve)));
        const index = new IndexService(app, settings);
        const oldRead = index.indexJournalFile(file as unknown as ObsidianFile);
        const newRead = index.indexJournalFile(file as unknown as ObsidianFile);
        resolves[1](content('New version', 'mood: calm\n'));
        await newRead;
        resolves[0](content('Old version', 'mood: grateful\n'));
        await oldRead;
        expect(index.getAllCaptures()[0].body).toBe('New version');
        expect(index.getAllCaptures()[0].mood).toBe('calm');
    });

    it('keeps the last valid index entry if a read fails', async () => {
        const { app, vault, file } = fixture();
        const index = new IndexService(app, settings);
        await index.indexJournalFile(file as unknown as ObsidianFile);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vault.cachedRead.mockRejectedValueOnce(new Error('I/O failed'));
        await index.indexJournalFile(file as unknown as ObsidianFile);
        expect(index.getAllCaptures()[0].body).toBe('First entry');
        expect(warning).toHaveBeenCalledOnce();
    });

    it('does not resurrect a deleted entry when an in-flight read finishes', async () => {
        const { app, vault, file, fileObjects } = fixture();
        let resolve!: (value: string) => void;
        vault.cachedRead.mockImplementation(() => new Promise(done => { resolve = done; }));
        const index = new IndexService(app, settings);
        const pending = index.indexJournalFile(file as unknown as ObsidianFile);
        fileObjects.delete(path);
        index.removeCaptureFile(path);
        resolve(content('Old entry'));
        await pending;
        expect(index.getAllCaptures()).toHaveLength(0);
    });

    it('loads an empty body only once and reports a missing file instead of returning success', async () => {
        const { app, vault, fileObjects } = fixture();
        (app.metadataCache.getFileCache as ReturnType<typeof vi.fn>).mockReturnValue({
            frontmatter: { created: '2025-09-27T10:00:00' },
        });
        const index = new IndexService(app, settings);
        await index.buildIndices();
        const entry = index.getAllCaptures()[0];
        vault.cachedRead.mockResolvedValueOnce(content(''));
        expect(await index.ensureEntryBodyLoaded(entry)).toBe('');
        expect(await index.ensureEntryBodyLoaded(entry)).toBe('');
        expect(vault.cachedRead).toHaveBeenCalledTimes(1);
        const unloaded = { ...entry, filePath: 'deleted.md', body: '' };
        fileObjects.delete(path);
        await expect(index.ensureEntryBodyLoaded(unloaded)).rejects.toThrow('Reflection not found');
    });

    it('indexes a large cached vault without disk reads', async () => {
        const { app, vault, fileObjects } = fixture();
        fileObjects.clear();
        for (let i = 0; i < 10_000; i++) {
            const entry = new TFile(`${folder}/2025/09/entry-${i}.md`);
            fileObjects.set(entry.path, entry);
        }
        (app.metadataCache.getFileCache as ReturnType<typeof vi.fn>).mockReturnValue({
            frontmatter: { created: '2025-09-27T10:00:00', day: '2025-09-27' },
        });
        const index = new IndexService(app, settings);
        const start = performance.now();
        await index.buildIndices();
        const elapsedMs = performance.now() - start;
        expect(index.getAllCaptures()).toHaveLength(10_000);
        expect(vault.cachedRead).not.toHaveBeenCalled();
        expect(elapsedMs).toBeLessThan(5_000);
        console.info(`10k metadata-only index: ${Math.round(elapsedMs)}ms`);
    });

    it('bounds simultaneous disk reads for an uncached startup', async () => {
        const { app, vault, fileObjects } = fixture();
        fileObjects.clear();
        for (let i = 0; i < 48; i++) {
            const entry = new TFile(`${folder}/2025/09/entry-${i}.md`);
            fileObjects.set(entry.path, entry);
        }
        let concurrent = 0;
        let peak = 0;
        vault.cachedRead.mockImplementation(async () => {
            concurrent++;
            peak = Math.max(peak, concurrent);
            await new Promise(resolve => setTimeout(resolve, 1));
            concurrent--;
            return content('Entry');
        });
        const index = new IndexService(app, settings);
        await index.buildIndices();
        expect(index.getAllCaptures()).toHaveLength(48);
        expect(peak).toBe(16);
    });

    it('never resurfaces a private, unburdening, or same-day entry', () => {
        const { app } = fixture();
        const index = new IndexService(app, settings);
        const yesterday = moment().subtract(1, 'day').format('YYYY-MM-DD');
        const today = moment().format('YYYY-MM-DD');
        const old = { id: path, filePath: path, day: yesterday, createdAtMs: moment(yesterday).valueOf(),
            favorite: true, private: false, type: 'journal', tags: [] } as unknown as ReturnType<IndexService['getAllCaptures']>[number];
        index.journalIndex.set(path, old);
        index.journalIndex.set('private', { ...old, id: 'private', filePath: 'private', private: true });
        index.journalIndex.set('sensitive', { ...old, id: 'sensitive', filePath: 'sensitive', tags: ['unburdening'] });
        index.journalIndex.set('today', { ...old, id: 'today', filePath: 'today', day: today });
        expect(index.getRandomMemory()?.filePath).toBe(path);
    });

    it('prioritizes safe anniversaries and avoids repeating the last resurfaced entry', () => {
        const { app } = fixture();
        const index = new IndexService(app, settings);
        const anniversary = moment().subtract(1, 'year');
        const day = anniversary.format('YYYY-MM-DD');
        const base = { day, createdAtMs: anniversary.valueOf(), private: false, type: 'journal',
            tags: [], favorite: false } as unknown as ReturnType<IndexService['getAllCaptures']>[number];
        index.journalIndex.set('first', { ...base, id: 'first', filePath: 'first' });
        index.journalIndex.set('second', { ...base, id: 'second', filePath: 'second', favorite: true });
        const ordinaryDay = moment().subtract(2, 'day');
        index.journalIndex.set('ordinary', { ...base, id: 'ordinary', filePath: 'ordinary',
            day: ordinaryDay.format('YYYY-MM-DD'), createdAtMs: ordinaryDay.valueOf() });
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(index.getRandomMemory()?.filePath).toBe('second');
        expect(index.getRandomMemory()?.filePath).toBe('first');
    });
});
