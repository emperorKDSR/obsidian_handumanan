import { Plugin, TFile, TFolder, Notice, WorkspaceLeaf, Platform, moment, addIcon } from 'obsidian';
import { 
    DEFAULT_SETTINGS, 
    VIEW_TYPE_DESKTOP_HUB, 
    VIEW_TYPE_MOBILE_HUB, 
    VIEW_TYPE_TABLET_HUB, 
    DESKTOP_HUB_ICON_ID, 
    DESKTOP_HUB_ICON_SVG 
} from './constants';
import { HandumananSettings } from './types';
import { isTablet } from './utils';
import { DesktopHubView } from './views/DesktopHubView';
import { HandumananSettingTab } from './settings';
import { IndexService } from './services/IndexService';
import { CaptureService } from './services/CaptureService';
import { RefreshCoordinator, type RefreshScope } from './application/RefreshCoordinator';

export default class HandumananPlugin extends Plugin {
    settings: HandumananSettings;
    settingsInitialized: boolean = false;
    private unloading = false;
    private startupRunToken = 0;
    private reactiveRuntimeEventsRegistered = false;
    private globalDomStateCaptured = false;
    private initialBodyHadTabletClass = false;
    private initialBodyHadDesktopClass = false;
    
    // Core Services
    index: IndexService;
    capture: CaptureService;
    refreshCoordinator: RefreshCoordinator;

    getContexts(): string[] {
        return this.settings?.contexts || [];
    }

    async updateSettingsBatch(patch: Partial<HandumananSettings>): Promise<void> {
        Object.assign(this.settings, patch);
        await this.saveSettings();
    }

    isMobile(): boolean {
        return (this.app as { isMobile?: boolean }).isMobile ?? Platform.isMobile;
    }

    async onload() {
        await this.loadSettings();
        this.unloading = false;
        this.captureGlobalDomState();
        this.applyMobileCssVars();
        this.applyDeviceBodyClasses();

        // Initialize Core Services
        this.index = new IndexService(this.app, this.settings);
        this.capture = new CaptureService(this.app, this.settings);
        this.refreshCoordinator = new RefreshCoordinator(this.app, this.settings, this.index);

        this.app.workspace.onLayoutReady(async () => {
            if (this.unloading) return;
            const startupToken = ++this.startupRunToken;
            this.registerReactiveRuntimeEvents();
            await this.runStartupIndexBuild(startupToken);
        });

        // Register Primary Views
        this.registerView(VIEW_TYPE_DESKTOP_HUB, (leaf) => new DesktopHubView(leaf, this));
        this.registerView(VIEW_TYPE_MOBILE_HUB, (leaf) => new DesktopHubView(leaf, this));
        this.registerView(VIEW_TYPE_TABLET_HUB, (leaf) => new DesktopHubView(leaf, this));

        // Add Ribbon & Command Icons
        addIcon(DESKTOP_HUB_ICON_ID, DESKTOP_HUB_ICON_SVG);

        this.addRibbonIcon(DESKTOP_HUB_ICON_ID, 'Handumanan Journal', () => {
            void this.activateWorkspace();
        });

        // Primary Journal Commands
        this.addCommand({
            id: 'handumanan-open-journal',
            name: 'Open Handumanan Life Journal',
            icon: DESKTOP_HUB_ICON_ID,
            callback: () => { void this.activateWorkspace(); }
        });

        this.addCommand({
            id: 'handumanan-open-sanctuary',
            name: 'Open Sanctuary Mode (Deep Reflection)',
            icon: 'edit',
            callback: () => { 
                void this.activateWorkspace(true); 
            }
        });

        this.addCommand({
            id: 'handumanan-toggle-privacy',
            name: 'Toggle Privacy Shield (Blur Reflections)',
            icon: 'eye-off',
            callback: () => {
                this.togglePrivacyShield();
            }
        });

        this.addCommand({
            id: 'handumanan-quick-capture',
            name: 'New Journal Entry',
            icon: 'plus',
            callback: () => { void this.activateWorkspace(); }
        });

        this.addSettingTab(new HandumananSettingTab(this.app, this));
    }

    async onunload() {
        this.unloading = true;
        this.startupRunToken++;
        this.restoreGlobalDomState();
        this.refreshCoordinator?.onunload();
        // Safe unload: do not destroy user tabs or tab history
    }

    private captureGlobalDomState(): void {
        if (this.globalDomStateCaptured) return;
        this.globalDomStateCaptured = true;
        this.initialBodyHadTabletClass = document.body.hasClass('is-tablet');
        this.initialBodyHadDesktopClass = document.body.hasClass('is-desktop');
    }

    private restoreGlobalDomState(): void {
        if (!this.globalDomStateCaptured) return;
        document.documentElement.style.removeProperty('--handumanan-mobile-bottombar-h');
        document.body.toggleClass('is-tablet', this.initialBodyHadTabletClass);
        document.body.toggleClass('is-desktop', this.initialBodyHadDesktopClass);
        document.body.classList.remove('is-handumanan-active');
    }

    async activateWorkspace(openSanctuary: boolean = false) {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(VIEW_TYPE_DESKTOP_HUB)
            .concat(workspace.getLeavesOfType(VIEW_TYPE_MOBILE_HUB))
            .concat(workspace.getLeavesOfType(VIEW_TYPE_TABLET_HUB));
        
        let leaf = existing[0];
        if (!leaf) {
            leaf = Platform.isDesktop ? workspace.getLeaf('tab') : workspace.getLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_DESKTOP_HUB, active: true });
            }
        }
        if (leaf) {
            workspace.revealLeaf(leaf);
            if (openSanctuary && leaf.view instanceof DesktopHubView) {
                leaf.view.focusComposer();
            }
        }
    }

    togglePrivacyShield(): void {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DESKTOP_HUB);
        for (const leaf of leaves) {
            if (leaf.view instanceof DesktopHubView) {
                leaf.view.togglePrivacyShield();
            }
        }
    }

    private async runStartupIndexBuild(startupToken: number): Promise<void> {
        try {
            await this.index.buildIndices();
            if (this.unloading || this.startupRunToken !== startupToken) return;
            this.notifyRefresh('all');
        } catch (error) {
            console.error('[Handumanan] Startup index build failed', error);
        }
    }

    private registerReactiveRuntimeEvents(): void {
        if (this.reactiveRuntimeEventsRegistered) return;
        this.reactiveRuntimeEventsRegistered = true;

        this.registerEvent(this.app.vault.on('create', async (f) => {
            if (f instanceof TFile && this.index.isJournalFile(f.path)) {
                await this.refreshCoordinator.reindexFile(f);
            }
        }));

        this.registerEvent(this.app.vault.on('modify', async (f) => {
            if (f instanceof TFile && this.index.isJournalFile(f.path)) {
                await this.refreshCoordinator.reindexFile(f, true);
            }
        }));

        this.registerEvent(this.app.vault.on('delete', (f) => {
            if (this.index.isJournalFile(f.path)) {
                this.index.removeCaptureFile(f.path);
                this.refreshCoordinator.notifyRefresh('journal');
            }
        }));

        this.registerEvent(this.app.vault.on('rename', async (f, oldPath) => {
            if (f instanceof TFile) {
                if (this.index.isJournalFile(oldPath) || this.index.isJournalFile(f.path)) {
                    this.index.handleRename(oldPath, f.path);
                    this.refreshCoordinator.notifyRefresh('journal');
                }
            } else if (f instanceof TFolder) {
                // If a year/month or journal folder was renamed, re-index
                await this.index.buildIndices();
                this.refreshCoordinator.notifyRefresh('all');
            }
        }));

        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            const isJournalView = leaf?.view?.getViewType() === VIEW_TYPE_DESKTOP_HUB;
            if (isJournalView) {
                document.body.classList.add('is-handumanan-active');
            } else {
                document.body.classList.remove('is-handumanan-active');
            }
        }));
    }

    notifyRefresh(scope: RefreshScope = 'all'): void {
        this.refreshCoordinator?.notifyRefresh(scope);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.settingsInitialized = true;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async updateSetting<K extends keyof HandumananSettings>(
        key: K, 
        value: HandumananSettings[K], 
        refreshScope: RefreshScope = 'all'
    ): Promise<void> {
        this.settings[key] = value;
        await this.saveSettings();
        this.index.updateSettings(this.settings);
        this.capture.updateSettings(this.settings);
        if (key === 'journalFolder') {
            await this.index.buildIndices();
        }
        this.notifyRefresh(refreshScope);
    }

    applyMobileCssVars(): void {
        const h = this.settings.mobileBottomBarHeight ?? 56;
        document.documentElement.style.setProperty('--handumanan-mobile-bottombar-h', `${h}px`);
    }

    applyDeviceBodyClasses(): void {
        const isTab = isTablet(this.app);
        const isDesk = Platform.isDesktop;
        document.body.classList.toggle('is-tablet', isTab);
        document.body.classList.toggle('is-desktop', isDesk);
    }
}
