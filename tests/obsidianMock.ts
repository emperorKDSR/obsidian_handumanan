import * as momentModule from 'moment';

export const moment: typeof momentModule =
    (momentModule as typeof momentModule & { default?: typeof momentModule }).default ?? momentModule;

export class TFile {
    basename: string;
    stat = { ctime: Date.now(), mtime: Date.now() };

    constructor(public path: string) {
        this.basename = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    }
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function parseYaml(source: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let listKey: string | null = null;
    for (const line of source.split(/\r?\n/)) {
        const field = line.match(/^([\w-]+):\s*(.*)$/);
        if (field) {
            const value = field[2].trim();
            if (value.startsWith('[')) result[field[1]] = JSON.parse(value);
            else if (value === '') result[field[1]] = [];
            else if (value === 'true' || value === 'false') result[field[1]] = value === 'true';
            else result[field[1]] = value.replace(/^["']|["']$/g, '');
            listKey = value ? null : field[1];
        } else if (listKey) {
            const item = line.match(/^\s+-\s+(.*)$/);
            if (item && Array.isArray(result[listKey])) {
                (result[listKey] as string[]).push(item[1].replace(/^["']|["']$/g, ''));
            }
        }
    }
    return result;
}
