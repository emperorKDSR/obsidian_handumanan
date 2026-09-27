import { HandumananSettings } from './types';

export const VIEW_TYPE_HANDUMANAN = "handumanan-view";
export const VIEW_TYPE_DIWA = VIEW_TYPE_HANDUMANAN;
export const VIEW_TYPE_DESKTOP_HUB = "handumanan-desktop-hub";
export const VIEW_TYPE_MOBILE_HUB  = "handumanan-mobile-hub";
export const VIEW_TYPE_TABLET_HUB  = "handumanan-tablet-hub";

// Desktop Hub ribbon icon — Journal Sanctuary Book aesthetic
export const DESKTOP_HUB_ICON_ID = "handumanan-journal-icon";
export const DESKTOP_HUB_ICON_SVG = `<g transform="translate(10,10) scale(3.5)">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="8" y1="7" x2="16" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="8" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</g>`;

// Action Icons (Simple paths for 16x16 / 24x24 viewbox)
export const ICON_PIN = '<path d="M12 2v8m0 0l4 4m-4-4l-4 4M4 14h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_EDIT = '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_TRASH = '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_PLUS = '<line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_REPLY = '<polyline points="9 17 4 12 9 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 18v-2a4 4 0 0 0-4-4H4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_EYE = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_EYE_OFF = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_SPARKLES = '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_HEART = '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
export const ICON_BOOK = '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

export const INTROSPECTIVE_PROMPTS = [
    "What caught your eye or touched you today?",
    "A feeling or conversation you want to preserve...",
    "What friction or unexpressed thought are you carrying?",
    "Where did you feel most alive recently?",
    "Speak your heart uncensored. What are you keeping from the world?",
    "How does your body feel right at this moment?",
    "What is something small you felt grateful for today?",
    "A lesson life quietly taught you recently..."
];

export const DEFAULT_SETTINGS: HandumananSettings = {
    journalFolder: '000 Bin/Handumanan',
    captureFolder: '000 Bin/Handumanan',
    newNoteFolder: '000 Bin',
    attachmentsFolder: '000 Bin/Handumanan Attachments',
    peopleFolder: '000 Bin/Handumanan People',
    thoughtsFolder: '000 Bin/Handumanan',
    tasksFolder: '000 Bin/Handumanan Gawa',
    pfFolder: '000 Bin/Handumanan PF',
    reviewsFolder: '000 Bin/Handumanan Reviews',
    privacyShieldDefault: false,
    promptDeckEnabled: true,
    mobileBottomBarHeight: 56,
    legacyMigrated: false,
};
