interface MobileSheetViewportOptions {
    sheetEl: HTMLElement;
    scrollEl?: HTMLElement | null;
    keyboardThreshold?: number;
}

const INPUT_SELECTOR = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]';

export function attachMobileSheetViewportBehavior({
    sheetEl,
    scrollEl = sheetEl,
    keyboardThreshold = 72,
}: MobileSheetViewportOptions): () => void {
    const win = sheetEl.ownerDocument.defaultView;
    if (!win) return () => {};

    const viewport = win.visualViewport;
    let frameId: number | null = null;
    const timeoutIds = new Set<number>();

    const clearPendingScroll = () => {
        if (frameId !== null) {
            win.cancelAnimationFrame(frameId);
            frameId = null;
        }
        timeoutIds.forEach((timeoutId) => win.clearTimeout(timeoutId));
        timeoutIds.clear();
    };

    const shouldScrollTarget = (target: HTMLElement): boolean => {
        if (target.matches(INPUT_SELECTOR)) return true;
        return !!scrollEl?.contains(target);
    };

    const scrollTargetIntoView = (target?: EventTarget | null) => {
        const element = target instanceof win.HTMLElement ? target : null;
        if (!element || !sheetEl.contains(element) || !shouldScrollTarget(element)) return;
        const rect = element.getBoundingClientRect();
        const visibleTop = viewport?.offsetTop ?? 0;
        const visibleBottom = Math.min(
            viewport ? viewport.offsetTop + viewport.height : win.innerHeight,
            win.innerHeight - readObsidianKeyboardHeight(),
        );
        if (rect.top >= visibleTop + 16 && rect.bottom <= visibleBottom - 16) return;
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };

    const scheduleScrollIntoView = (target?: EventTarget | null) => {
        clearPendingScroll();
        const run = () => scrollTargetIntoView(target ?? win.document.activeElement);
        frameId = win.requestAnimationFrame(run);
        [120, 280].forEach((delay) => {
            const timeoutId = win.setTimeout(run, delay);
            timeoutIds.add(timeoutId);
        });
    };

    const readObsidianKeyboardHeight = (): number => {
        const raw = win.getComputedStyle(win.document.documentElement).getPropertyValue('--keyboard-height');
        return Math.max(0, parseFloat(raw) || 0);
    };

    const syncKeyboardState = () => {
        const viewportKeyboardHeight = viewport
            ? Math.max(0, Math.round(win.innerHeight - (viewport.height + viewport.offsetTop)))
            : 0;
        const keyboardOpen = viewportKeyboardHeight >= keyboardThreshold
            || readObsidianKeyboardHeight() >= keyboardThreshold;
        sheetEl.toggleClass('has-mobile-keyboard', keyboardOpen);
        if (keyboardOpen) scheduleScrollIntoView();
    };

    const handleFocusIn = (event: FocusEvent) => {
        scheduleScrollIntoView(event.target);
    };

    const handleViewportChange = () => {
        syncKeyboardState();
    };

    const keyboardEvents = ['keyboardWillShow', 'keyboardDidShow', 'keyboardWillHide', 'keyboardDidHide'];
    sheetEl.addEventListener('focusin', handleFocusIn, true);
    win.addEventListener('resize', handleViewportChange);
    viewport?.addEventListener('resize', handleViewportChange);
    viewport?.addEventListener('scroll', handleViewportChange);
    keyboardEvents.forEach(name => win.addEventListener(name, handleViewportChange));

    syncKeyboardState();

    return () => {
        clearPendingScroll();
        keyboardEvents.forEach(name => win.removeEventListener(name, handleViewportChange));
        sheetEl.removeEventListener('focusin', handleFocusIn, true);
        win.removeEventListener('resize', handleViewportChange);
        viewport?.removeEventListener('resize', handleViewportChange);
        viewport?.removeEventListener('scroll', handleViewportChange);
        sheetEl.removeClass('has-mobile-keyboard');
    };
}
