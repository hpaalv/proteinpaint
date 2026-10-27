/**
 * Promise-based file dialogs for the web build, where the files live on the server
 * (an HPC node) and the native dialogs of Electron do not exist. The web bridge
 * (web.ts) awaits these; <FileDialogHost> renders the one pending request.
 */

import { create } from 'zustand';

export type FileDialogRequest =
    | { kind: 'open'; title: string; start?: string }
    | { kind: 'folder'; title: string; start?: string }
    | { kind: 'save'; title: string; suggestedName: string; start?: string }
    | { kind: 'browse'; title: string; start: string; highlight?: string };

export type FileDialogResult =
    | { kind: 'paths'; paths: string[] }
    /** Files picked on the user's own machine, read in the browser. */
    | { kind: 'local'; files: File[] }
    | { kind: 'download' }
    | null;

interface Pending {
    request: FileDialogRequest;
    resolve: (r: FileDialogResult) => void;
}

export const useFileDialog = create<{ pending: Pending | null }>(() => ({ pending: null }));

export function askFile(request: FileDialogRequest): Promise<FileDialogResult> {
    // One dialog at a time: a second request cancels the first, as a native dialog would refuse it.
    useFileDialog.getState().pending?.resolve(null);
    return new Promise((resolve) => {
        useFileDialog.setState({
            pending: {
                request,
                resolve: (r) => {
                    useFileDialog.setState({ pending: null });
                    resolve(r);
                },
            },
        });
    });
}

const LAST_DIR_KEY = 'pp.fileDialog.lastDir';

/** The folder the last dialog ended in, so the next one opens there. */
export function lastDir(): string | null {
    try {
        return localStorage.getItem(LAST_DIR_KEY);
    } catch {
        return null;
    }
}

export function rememberDir(dir: string): void {
    try {
        localStorage.setItem(LAST_DIR_KEY, dir);
    } catch {
        // Private windows: the next dialog simply starts at home.
    }
}
