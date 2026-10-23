/**
 * Canonical views derived from the complex's geometry, as cdr_panels.py does instead
 * of `view orient`: reproducible across designs, so the same panel of 50 designs is
 * shot from the same side.
 *
 *   dock   — from the target's interface (or the peptide) to the binder's interface
 *   groove — the peptide's long axis (or the target interface's), orthogonal to dock
 *   side   — dock × groove
 */

import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { atomTable, atomsNear, centroid, cross, dot, principalAxis, rotate, scale, sub, unit, type V3 } from './geometry';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type Result, type StructureId } from './types';

export type CanonicalView = 'side' | 'top' | 'threequarter' | 'groove' | 'back';

export const CANONICAL_VIEW_LABELS: Record<CanonicalView, { label: string; title: string }> = {
    side: { label: 'Lateral', title: 'De lado: o binder em cima, o alvo embaixo (eixo de docking na vertical)' },
    top: { label: 'Topo', title: 'De cima, pelo binder: o footprint sobre o alvo, peptídeo na horizontal' },
    threequarter: { label: '¾', title: 'Lateral girada 40° e inclinada 22°, como no cdr_panels.py' },
    groove: { label: 'Sulco', title: 'Ao longo do peptídeo (eixo do sulco apontando para a câmera)' },
    back: { label: 'Verso', title: 'Lateral pelo lado oposto' },
};

export interface DockingAxes {
    dock: V3;
    groove: V3;
    side: V3;
    /** How the groove axis was found, for the UI. */
    grooveFrom: 'peptide' | 'interface';
}

export function dockingAxes(viewer: Viewer, id: StructureId, contact = 5): Result<DockingAxes> {
    const info = viewer.entry(id)?.info;
    if (!info) return err('Estrutura não encontrada.');
    const polymer = info.chains.filter((c) => c.isPolymer);
    const binder = new Set(polymer.filter((c) => c.role === 'binder').map((c) => c.authAsymId));
    const target = new Set(polymer.filter((c) => c.role !== 'binder').map((c) => c.authAsymId));
    if (binder.size === 0 || target.size === 0) return err('Marque a cadeia do binder (papel "binder") e mantenha o alvo em outra cadeia.');

    const a = atomTable(viewer, id, { chains: binder });
    const b = atomTable(viewer, id, { chains: target });
    const ia = atomsNear(a, b, contact);
    const ib = atomsNear(b, a, contact);
    if (ia.length === 0 || ib.length === 0) return err(`Binder e alvo não se tocam (nenhum átomo a ≤ ${contact} Å).`);

    const peptide = new Set(polymer.filter((c) => c.role === 'peptide').map((c) => c.authAsymId));
    const peptideCA: number[] = [];
    for (let i = 0; i < b.count; i++) if (b.isCA[i] && peptide.has(b.chain[i]!)) peptideCA.push(i);

    const binderCenter = centroid(a.xyz, ia)!;
    const targetCenter = peptideCA.length >= 3 ? centroid(b.xyz, peptideCA)! : centroid(b.xyz, ib)!;
    const dock = unit(sub(binderCenter, targetCenter));

    let groove = peptideCA.length >= 3 ? principalAxis(b.xyz, peptideCA) : principalAxis(b.xyz, ib);
    if (!groove) return err('Não foi possível achar o eixo do sulco.');
    if (peptideCA.length >= 3) {
        // N→C direction, so "groove" views are not mirrored between designs.
        const first = peptideCA[0]!;
        const last = peptideCA[peptideCA.length - 1]!;
        const nc: V3 = [b.xyz[last * 3]! - b.xyz[first * 3]!, b.xyz[last * 3 + 1]! - b.xyz[first * 3 + 1]!, b.xyz[last * 3 + 2]! - b.xyz[first * 3 + 2]!];
        if (dot(groove, nc) < 0) groove = scale(groove, -1);
    }
    groove = unit(sub(groove, scale(dock, dot(groove, dock))));
    return ok({ dock, groove, side: unit(cross(dock, groove)), grooveFrom: peptideCA.length >= 3 ? 'peptide' : 'interface' });
}

/** Camera forward (from the eye into the scene) and up vectors for a view. */
function viewVectors(axes: DockingAxes, view: CanonicalView): { forward: V3; up: V3 } {
    const { dock, groove, side } = axes;
    switch (view) {
        case 'side':
            return { forward: scale(side, -1), up: dock };
        case 'back':
            return { forward: side, up: dock };
        case 'top':
            return { forward: scale(dock, -1), up: groove };
        case 'groove':
            return { forward: groove, up: dock };
        case 'threequarter':
            return { forward: rotate(rotate(scale(side, -1), dock, 40), groove, -22), up: rotate(dock, groove, -22) };
    }
}

export function canonicalView(viewer: Viewer, id: StructureId, view: CanonicalView, durationMs = 600): Result<DockingAxes> {
    const canvas = viewer.canvas3d;
    if (!canvas) return err('O visualizador ainda não está pronto.');
    try {
        const axes = dockingAxes(viewer, id);
        if (!axes.ok) return axes;
        const { forward, up } = viewVectors(axes.value, view);
        const apply = () => {
            const sphere = canvas.boundingSphereVisible;
            const snapshot = canvas.camera.getInvariantFocus(Vec3.clone(sphere.center), Math.max(sphere.radius, 10), Vec3.create(...up), Vec3.create(...forward));
            viewer.plugin.managers.camera.setSnapshot(snapshot, durationMs, { easing: 'cubic-in-out', trajectory: 'linear' } as never);
        };
        // A representation reaches the canvas a frame after its state commit; framing
        // before that uses an empty bounding sphere and leaves the molecule a speck.
        if (canvas.boundingSphereVisible.radius > 0 && canvas.reprCount.value > 0) apply();
        else {
            let frames = 0;
            const attempt = () => {
                if (canvas.boundingSphereVisible.radius > 0 && canvas.reprCount.value > 0) apply();
                else if (frames++ < 180) requestAnimationFrame(attempt);
            };
            attempt();
        }
        return ok(axes.value);
    } catch (e) {
        return err(`Falha ao orientar a câmera: ${errorMessage(e)}`);
    }
}
