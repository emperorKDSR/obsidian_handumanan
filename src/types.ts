import { TFile } from 'obsidian';

export type JournalType = 'journal' | 'reflection' | 'unburdening' | 'gratitude' | 'dream' | 'memory';
export type JournalMood = 'calm' | 'quiet' | 'vulnerable' | 'heavy' | 'energized' | 'grateful' | 'melancholy' | string;

export interface JournalEntry {
    id: string;
    filePath: string;
    title: string;
    created: string; // ISO-8601 or YYYY-MM-DD HH:mm:ss
    modified: string;
    createdAtMs?: number;
    day: string; // YYYY-MM-DD
    type?: JournalType;
    mood?: string;
    valence?: number; // -2 to +2
    energy?: string;
    people?: string[]; // [[Person]]
    places?: string[]; // [[Place]]
    weather?: string;
    soundtrack?: string;
    prompt?: string;
    photos?: string[];
    tags?: string[];
    body: string;
    pinned?: boolean;
    favorite?: boolean;
    private?: boolean;
    allDates?: string[];
    wikilinks?: string[];
    wordCount?: number;
    readingTimeMin?: number;
    // Backward-tolerance fields
    createdAt?: number;
    updatedAt?: number;
    state?: 'raw' | 'refined' | 'important';
    content?: string;
    context?: string[];
    area?: string;
    hasTasks?: boolean;
    topic?: string | string[] | null;
    journalType?: string | null;
    archived?: boolean;
    synthesized?: boolean;
    lastThreadUpdate?: number;
    links?: {
        tasks?: string[];
        thoughts?: string[];
    };
    tasks?: { lineIndex: number; rawLine: string; title: string; completed: boolean }[];
}

export type JournalFilterMode = 
    | 'all' 
    | 'today' 
    | 'this_week' 
    | 'on_this_day' 
    | 'favorites' 
    | 'unburdening' 
    | string;

export type ScratchpadFilterMode = JournalFilterMode;

export type CaptureEntry = JournalEntry;
export type ThoughtEntry = JournalEntry;

export interface HandumananSettings {
    journalFolder: string;
    captureFolder?: string; // Backward compatibility fallback
    newNoteFolder: string;
    attachmentsFolder: string;
    peopleFolder: string;
    privacyShieldDefault: boolean;
    promptDeckEnabled: boolean;
    dailyTemplate?: string;
    mobileBottomBarHeight: number;
    legacyMigrated?: boolean;
    contexts?: string[];
    hiddenContexts?: string[];
    thoughtsFolder?: string;
    tasksFolder?: string;
    pfFolder?: string;
    reviewsFolder?: string;
}

export type DiwaSettings = HandumananSettings;
export type FileOrCreate = TFile | string;

