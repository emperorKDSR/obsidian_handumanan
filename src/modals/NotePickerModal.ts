import { App, TFile, FuzzySuggestModal } from 'obsidian';

export class NotePickerModal extends FuzzySuggestModal<TFile> {
    onChoose: (file: TFile) => void;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder('Search notes to pin for chat context...');
    }

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles()
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}

