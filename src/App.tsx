import { useEffect } from 'react';
import * as E from '@/engine';
import { run, toast, useApp, viewer } from '@/store/app';
import { browseStep, openFiles, openFolder, setTool } from '@/store/actions';
import { redo, undo } from '@/store/history';
import { Inspector, TAB_KEYS } from '@/ui/layout/Inspector';
import { SequenceTrack } from '@/ui/layout/SequenceTrack';
import { Sidebar } from '@/ui/layout/Sidebar';
import { StatusBar, Toasts } from '@/ui/layout/StatusBar';
import { TopBar } from '@/ui/layout/TopBar';
import { Viewport } from '@/ui/layout/Viewport';
import { cx } from '@/ui/components/Primitives';
import { Dock } from '@/ui/analysis/Dock';
import { DataWorkspace } from '@/ui/data/DataWorkspace';

function isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
}

/** Global shortcuts. Ignored while typing so the spec box and renames work normally. */
function useShortcuts() {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const v = viewer();
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                void undo();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
                e.preventDefault();
                void redo();
                return;
            }
            if (e.ctrlKey && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                void (e.shiftKey ? openFolder() : openFiles());
                return;
            }
            if (isTyping(e)) return;
            // The data workspace has its own shortcuts; the 3D ones would act on a hidden scene.
            if (useApp.getState().workspace === 'data' || !v) return;
            if (e.altKey) {
                const tab = TAB_KEYS.find(([k]) => k === e.key)?.[1];
                if (tab) {
                    e.preventDefault();
                    useApp.setState({ tab });
                }
                return;
            }
            if (e.ctrlKey || e.metaKey) return;
            switch (e.key) {
                case 'Escape':
                    E.clearSelection(v);
                    E.clearFocus(v);
                    E.restoreClipRadius(v);
                    if (useApp.getState().tool === 'measure') setTool('select');
                    break;
                case 'f':
                case 'F':
                    E.focusSelection(v, e.shiftKey);
                    break;
                case 'r':
                case 'R':
                    E.resetView(v);
                    break;
                case 's':
                    setTool('select');
                    break;
                case 'e':
                    setTool('explore');
                    break;
                case 'm':
                    setTool('measure');
                    break;
                // ↑/↓ act on the selection level when something is selected (ChimeraX), and
                // browse the library otherwise; PageUp/PageDown always browse.
                case 'ArrowUp':
                    e.preventDefault();
                    if (useApp.getState().selection) {
                        void run(E.promoteSelection(v)).then((level) => {
                            if (level) toast(`Seleção: ${E.SELECTION_LEVEL_NAMES[level]}`, 'info', 1200);
                        });
                    } else if (useApp.getState().library.files.length) void browseStep(-1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    if (E.demoteSelection(v)) break;
                    if (!useApp.getState().selection && useApp.getState().library.files.length) void browseStep(1);
                    break;
                case 'PageUp':
                    if (useApp.getState().library.files.length) {
                        e.preventDefault();
                        void browseStep(-1);
                    }
                    break;
                case 'PageDown':
                    if (useApp.getState().library.files.length) {
                        e.preventDefault();
                        void browseStep(1);
                    }
                    break;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}

export function App() {
    useShortcuts();
    const workspace = useApp((s) => s.workspace);
    return (
        <div className="flex h-full flex-col">
            <TopBar />
            {/*
             * Both workspaces stay mounted: the 3D one owns a WebGL context and
             * re-creating it on every switch would reload every structure.
             */}
            <div className={cx('flex min-h-0 flex-1', workspace === 'data' && 'hidden')}>
                <Sidebar />
                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                        <Viewport />
                        <SequenceTrack />
                    </div>
                    <Dock />
                </div>
                <Inspector />
            </div>
            {workspace === 'data' && <DataWorkspace />}
            <StatusBar />
            <Toasts />
        </div>
    );
}
