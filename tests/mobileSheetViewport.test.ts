import { describe, expect, it, vi } from 'vitest';
import { attachMobileSheetViewportBehavior } from '../src/utils/mobileSheetViewport';

function createMobileViewport() {
    let keyboardHeight = 0;
    const classes = new Set<string>();
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 800 });

    class FakeElement extends EventTarget {
        ownerDocument!: Document;
        top = 100;
        bottom = 144;
        scrollIntoView = vi.fn();

        contains(target: EventTarget | null): boolean {
            return target === this || target === input;
        }

        matches(): boolean {
            return true;
        }

        getBoundingClientRect(): DOMRect {
            return { top: this.top, bottom: this.bottom } as DOMRect;
        }

        toggleClass(name: string, enabled: boolean): void {
            if (enabled) classes.add(name);
            else classes.delete(name);
        }

        removeClass(name: string): void {
            classes.delete(name);
        }
    }

    const sheet = new FakeElement();
    const input = new FakeElement();
    const document = {
        documentElement: {},
        activeElement: input,
    };
    const win = Object.assign(new EventTarget(), {
        innerHeight: 800,
        visualViewport: viewport,
        HTMLElement: FakeElement,
        document,
        getComputedStyle: () => ({ getPropertyValue: () => `${keyboardHeight}px` }),
        requestAnimationFrame: (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        },
        cancelAnimationFrame: vi.fn(),
        setTimeout: () => 1,
        clearTimeout: vi.fn(),
    });
    sheet.ownerDocument = { defaultView: win } as unknown as Document;

    return {
        sheet,
        input,
        viewport,
        classes,
        setKeyboardHeight: (height: number) => { keyboardHeight = height; },
        notifyKeyboard: () => win.dispatchEvent(new Event('keyboardDidShow')),
    };
}

describe('mobile keyboard viewport behavior', () => {
    it('detects the iOS keyboard through Obsidian even when the visual viewport does not shrink', () => {
        const mobile = createMobileViewport();
        const cleanup = attachMobileSheetViewportBehavior({ sheetEl: mobile.sheet as unknown as HTMLElement });

        mobile.setKeyboardHeight(300);
        mobile.notifyKeyboard();
        expect(mobile.classes.has('has-mobile-keyboard')).toBe(true);
        expect(mobile.input.scrollIntoView).not.toHaveBeenCalled();

        mobile.setKeyboardHeight(0);
        mobile.notifyKeyboard();
        expect(mobile.classes.has('has-mobile-keyboard')).toBe(false);
        cleanup();
    });

    it('scrolls only an obscured input and recognizes a shrinking visual viewport', () => {
        const mobile = createMobileViewport();
        const cleanup = attachMobileSheetViewportBehavior({ sheetEl: mobile.sheet as unknown as HTMLElement });

        mobile.viewport.height = 500;
        mobile.input.top = 480;
        mobile.input.bottom = 524;
        mobile.viewport.dispatchEvent(new Event('resize'));
        expect(mobile.classes.has('has-mobile-keyboard')).toBe(true);
        expect(mobile.input.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });

        cleanup();
        expect(mobile.classes.has('has-mobile-keyboard')).toBe(false);
    });
});
