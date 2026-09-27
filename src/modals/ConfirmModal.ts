import { App, Modal, setIcon } from 'obsidian';

export class ConfirmModal extends Modal {
    message: string;
    onConfirm: () => void;

    constructor(app: App, message: string, onConfirm: () => void) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        this.modalEl.style.cssText = 'border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.25); max-width: 380px; padding: 0; overflow: hidden;';
        const { contentEl } = this;
        contentEl.empty();
        contentEl.style.padding = '0';

        const header = contentEl.createEl('div', { attr: { style: 'padding: 20px 24px 16px 24px; border-bottom: 1px solid var(--background-modifier-border-faint);' } });
        const iconWrap = header.createEl('div', { attr: { style: 'width: 36px; height: 36px; border-radius: 50%; background: rgba(220,50,50,0.12); display: flex; align-items: center; justify-content: center; margin-bottom: 12px; color: var(--text-error);' } });
        setIcon(iconWrap, 'alert-triangle');
        header.createEl('h3', { text: 'Confirm Action', attr: { style: 'margin: 0 0 6px 0; font-size: 1em; font-weight: 700; color: var(--text-normal);' } });
        header.createEl('p', { text: this.message, attr: { style: 'margin: 0; font-size: 0.9em; color: var(--text-muted); line-height: 1.5;' } });

        const footer = contentEl.createEl('div', { attr: { style: 'padding: 16px 24px; display: flex; justify-content: flex-end; gap: 10px; background: var(--background-secondary);' } });
        const noBtn = footer.createEl('button', { text: 'Cancel', attr: { style: 'padding: 8px 16px; border-radius: 8px; background: transparent; border: 1px solid var(--background-modifier-border); color: var(--text-muted); font-weight: 600; cursor: pointer;' } });
        const yesBtn = footer.createEl('button', { text: 'Confirm', attr: { style: 'padding: 8px 18px; border-radius: 8px; background: var(--text-error); color: #fff; border: none; font-weight: 700; cursor: pointer;' } });

        yesBtn.addEventListener('click', () => { this.onConfirm(); this.close(); });
        noBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

