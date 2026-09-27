import { App, PluginSettingTab, Setting, TextComponent, ToggleComponent } from 'obsidian';
import type HandumananPlugin from './main';

export function bindDeferredTextSetting(
    text: TextComponent,
    initialValue: string,
    onCommit: (value: string) => Promise<void>,
): () => Promise<void> {
    let draftValue = initialValue;
    let committedValue = initialValue;
    let saveChain = Promise.resolve();

    const commitValue = (value: string): Promise<void> => {
        if (value === committedValue) return saveChain;
        saveChain = saveChain
            .catch(() => undefined)
            .then(async () => {
                if (value === committedValue) return;
                await onCommit(value);
                committedValue = value;
            });
        return saveChain;
    };

    text
        .setValue(initialValue)
        .onChange((value) => {
            draftValue = value;
        });

    const flushDraft = (): Promise<void> => commitValue(draftValue);
    text.inputEl.addEventListener('blur', () => {
        void flushDraft();
    });
    text.inputEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void flushDraft();
        text.inputEl.blur();
    });

    return flushDraft;
}

export class HandumananSettingTab extends PluginSettingTab {
    plugin: HandumananPlugin;

    constructor(app: App, plugin: HandumananPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Handumanan Journal' });

        // ── 1. Storage & Journaling Vault Folders ──
        containerEl.createEl('h3', { text: 'Storage & Folders' });

        new Setting(containerEl)
            .setName('Journal Folder')
            .setDesc('Root folder for life journal entries (partitioned automatically by YYYY/MM).')
            .addText(text => {
                text.setPlaceholder('000 Bin/Handumanan');
                const current = this.plugin.settings.journalFolder || this.plugin.settings.captureFolder || '000 Bin/Handumanan';
                bindDeferredTextSetting(text, current, async (value) => {
                    await this.plugin.updateSetting('journalFolder', value);
                });
            });

        new Setting(containerEl)
            .setName('Attachments Folder')
            .setDesc('Folder where photos, media, and pasted assets are saved.')
            .addText(text => {
                text.setPlaceholder('000 Bin/Handumanan Attachments');
                bindDeferredTextSetting(text, this.plugin.settings.attachmentsFolder ?? '000 Bin/Handumanan Attachments', async (value) => {
                    await this.plugin.updateSetting('attachmentsFolder', value);
                });
            });

        new Setting(containerEl)
            .setName('People / Constellations Folder')
            .setDesc('Folder where people profiles and relational notes are stored for @person mentions.')
            .addText(text => {
                text.setPlaceholder('000 Bin/Handumanan People');
                bindDeferredTextSetting(text, this.plugin.settings.peopleFolder ?? '000 Bin/Handumanan People', async (value) => {
                    await this.plugin.updateSetting('peopleFolder', value);
                });
            });

        // ── 2. Privacy & Introspection ──
        containerEl.createEl('h3', { text: 'Privacy & Introspection' });

        new Setting(containerEl)
            .setName('Default Privacy Shield')
            .setDesc('Automatically blur journal stream entries upon opening the workspace to protect vulnerable entries during screen-sharing or in public spaces.')
            .addToggle(toggle => {
                toggle.setValue(Boolean(this.plugin.settings.privacyShieldDefault));
                toggle.onChange(async (val) => {
                    await this.plugin.updateSetting('privacyShieldDefault', val);
                });
            });

        new Setting(containerEl)
            .setName('Introspective Prompt Deck')
            .setDesc('Display rotating gentle reflection prompts in the composer when starting a new entry.')
            .addToggle(toggle => {
                toggle.setValue(Boolean(this.plugin.settings.promptDeckEnabled));
                toggle.onChange(async (val) => {
                    await this.plugin.updateSetting('promptDeckEnabled', val);
                });
            });
    }
}

// Backward compatibility alias
export const DiwaSettingTab = HandumananSettingTab;
