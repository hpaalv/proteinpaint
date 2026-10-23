/**
 * Saved figure styles ("meu estilo de figura"): a look plus the chain palette, kept in
 * localStorage and applicable to whatever is loaded. A style holds no structure data,
 * so the same style works on any design.
 */

import { create } from 'zustand';
import * as E from '@/engine';
import type { ChainPaletteId } from '@/data/palettes';
import { run, toast, useApp, viewer } from './app';

export interface SavedStyle {
    id: string;
    name: string;
    look: E.Look;
    palette: ChainPaletteId | null;
    created: number;
}

const KEY = 'proteinpaint.styles.v1';

function load(): SavedStyle[] {
    try {
        const raw = localStorage.getItem(KEY);
        const parsed = raw ? (JSON.parse(raw) as SavedStyle[]) : [];
        return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.name === 'string' && s.look) : [];
    } catch {
        return [];
    }
}

function persist(styles: SavedStyle[]): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(styles));
    } catch {
        toast('Não foi possível gravar a biblioteca de estilos.', 'error');
    }
}

export const useStyles = create<{ styles: SavedStyle[] }>(() => ({ styles: load() }));

export function saveCurrentStyle(name: string): void {
    const v = viewer();
    if (!v) return;
    const trimmed = name.trim() || `Estilo ${useStyles.getState().styles.length + 1}`;
    const style: SavedStyle = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: trimmed, look: E.getLook(v), palette: v.chainPalette, created: Date.now() };
    // Same name replaces: saving again after tweaking updates the style.
    const styles = [style, ...useStyles.getState().styles.filter((s) => s.name !== trimmed)];
    useStyles.setState({ styles });
    persist(styles);
    toast(`Estilo "${trimmed}" salvo.`, 'ok', 2000);
}

export async function applySavedStyle(style: SavedStyle): Promise<void> {
    const v = viewer();
    if (!v) return;
    useApp.setState((s) => ({ look: 'custom', lookRev: s.lookRev + 1 }));
    const blend = E.applyLook(v, style.look);
    if (style.palette && style.palette !== v.chainPalette) await run(E.setChainPalette(v, style.palette));
    await blend;
}

export function deleteStyle(id: string): void {
    const styles = useStyles.getState().styles.filter((s) => s.id !== id);
    useStyles.setState({ styles });
    persist(styles);
}
