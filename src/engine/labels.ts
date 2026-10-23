/**
 * Residue labels with leader lines.
 *
 * Mol*'s own label sits on top of the residue, which in a crowded interface lands on
 * the atoms it is naming. Here each label is pushed out of the structure and joined
 * to its residue by a dashed leader — a diagonal segment to an elbow, then a straight
 * one to the text — the way labels are drawn in published figures.
 *
 * The leader is real 3D geometry (the same overlay mesh the interactions use), so it
 * stays attached when the camera moves, and the text uses Mol*'s world-space offset
 * so both ends always agree.
 */

import { OrderedSet } from 'molstar/lib/mol-data/int';
import { StructureElement, StructureProperties as P } from 'molstar/lib/mol-model/structure';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { clearOverlay, setOverlay, setTextOverlay, type OverlayLine, type OverlayText, type Point } from './overlay';
import { selectedLoci } from './selection';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type Result } from './types';

export type LabelContent = 'residue' | 'residue-chain' | 'name-only' | 'number-only' | 'chain-only';

export interface LabelStyle {
    content: LabelContent;
    /** Text height, in Å of world space. */
    size: number;
    color: number;
    /** Dark plate behind the text, for labels over a pale surface. */
    background: boolean;
    backgroundColor: number;
    backgroundOpacity: number;
    /** 0 = the label sits on the residue (no leader). */
    leaderLength: number;
    /** Dashed leader, as in the reference figures. */
    leader: boolean;
    leaderColor: number;
    leaderDashes: number;
    leaderWidth: number;
    /** Outline around the glyphs — keeps text readable over any colour. */
    outline: boolean;
}

export const DEFAULT_LABEL_STYLE: LabelStyle = {
    content: 'residue',
    size: 2.4,
    color: 0xe6ecf5,
    background: false,
    backgroundColor: 0x0b0e14,
    backgroundOpacity: 0.7,
    leaderLength: 6,
    leader: true,
    leaderColor: 0x9aa8bf,
    leaderDashes: 3,
    leaderWidth: 0.08,
    outline: true,
};

const LEADER_OVERLAY = 'label-leaders';
const TEXT_OVERLAY = 'label-text';

interface Anchor {
    /** Residue centroid, where the leader starts. */
    position: Vec3;
    loci: StructureElement.Loci;
    text: string;
    owner: string | null;
}

function residueText(location: StructureElement.Location, content: LabelContent): string {
    const chain = P.chain.auth_asym_id(location);
    const name = P.residue.auth_comp_id(location);
    const seq = P.residue.auth_seq_id(location);
    const ins = P.residue.pdbx_PDB_ins_code(location) || '';
    switch (content) {
        case 'residue':
            return `${name}${seq}${ins}`;
        case 'residue-chain':
            return `${chain}/${name}${seq}${ins}`;
        case 'name-only':
            return name;
        case 'number-only':
            return `${seq}${ins}`;
        case 'chain-only':
            return chain;
    }
}

/** One anchor per residue in the selection, with its centroid and text. */
function anchors(viewer: Viewer, loci: StructureElement.Loci[], content: LabelContent): Anchor[] {
    const out: Anchor[] = [];
    for (const l of loci) {
        const owner = viewer.idOf(l.structure);
        for (const { unit, indices } of l.elements) {
            const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
            const seen = new Set<number>();
            for (let i = 0, n = OrderedSet.size(indices); i < n; i++) {
                const unitIndex = OrderedSet.getAt(indices, i);
                const r = residueOf[unit.elements[unitIndex]!]!;
                if (seen.has(r)) continue;
                seen.add(r);
                const atom = StructureElement.Loci(l.structure, [{ unit, indices: OrderedSet.ofSingleton(unitIndex) }]);
                const residueLoci = StructureElement.Loci.extendToWholeResidues(atom);
                const centre = Vec3();
                let count = 0;
                const p = Vec3();
                for (const e of residueLoci.elements) {
                    OrderedSet.forEach(e.indices, (k) => {
                        e.unit.conformation.position(e.unit.elements[k]!, p);
                        Vec3.add(centre, centre, p);
                        count++;
                    });
                }
                if (count === 0) continue;
                Vec3.scale(centre, centre, 1 / count);
                const location = StructureElement.Location.create(l.structure, unit, unit.elements[unitIndex]!);
                out.push({ position: centre, loci: residueLoci, text: residueText(location, content), owner });
            }
        }
    }
    return out;
}

/**
 * Where a label's text goes: out of the molecule along the direction from its centre
 * to the residue, lifted a little, so labels fan outwards instead of piling up.
 * `rank` spreads labels that would otherwise land on the same spot.
 */
function placement(anchor: Vec3, centre: Vec3, radius: number, margin: number, rank: number): { elbow: Vec3; text: Vec3 } {
    const outward = Vec3.sub(Vec3(), anchor, centre);
    if (Vec3.magnitude(outward) < 1e-3) Vec3.set(outward, 1, 0, 0);
    Vec3.normalize(outward, outward);
    // The diagonal leaves the residue outwards and tilted, alternating up and down so
    // neighbouring labels separate instead of stacking.
    const up = Vec3.create(0, rank % 2 === 0 ? 1 : -1, 0);
    const diagonal = Vec3.normalize(Vec3(), Vec3.add(Vec3(), outward, Vec3.scale(Vec3(), up, 0.9)));
    // The text lands outside the structure's bounding sphere: a residue buried in a
    // groove still gets its label in clear space instead of over the protein.
    const target = Vec3.scaleAndAdd(Vec3(), centre, outward, radius + margin);
    // Elbow two thirds of the way along the diagonal, so the run into the text is the
    // straight segment — the diagonal-then-straight leader of a printed figure.
    const distance = Vec3.distance(anchor, target);
    const elbow = Vec3.scaleAndAdd(Vec3(), anchor, diagonal, Math.max(1, distance * 0.6));
    return { elbow, text: target };
}

/**
 * Labels every residue of the current selection. Replaces whatever was labelled
 * before, so changing the style is one call, not "clear then redo".
 */
export async function labelSelection(viewer: Viewer, style: LabelStyle = DEFAULT_LABEL_STYLE): Promise<Result<number>> {
    const selected = selectedLoci(viewer);
    if (selected.length === 0) return err('Nada selecionado.');
    try {
        await clearLabels(viewer);
        const list = anchors(viewer, selected, style.content);
        if (list.length === 0) return err('Nada selecionado.');

        // Labels are pushed away from the *structure*, not from the labelled set: a
        // peptide sitting in a groove would otherwise fan its labels along the groove,
        // straight into the protein.
        const centre = Vec3.clone(selected[0]!.structure.boundary.sphere.center);

        // On a large complex a fixed 6 Å leader still ends inside the protein; scale it
        // with the structure's radius but keep the user's number as the floor.
        const radius = selected[0]!.structure.boundary.sphere.radius;
        const lines: OverlayLine[] = [];
        const texts: OverlayText[] = [];
        for (let i = 0; i < list.length; i++) {
            const a = list[i]!;
            const owners = a.owner ? [a.owner] : undefined;
            let textAt = a.position;
            if (style.leader && style.leaderLength > 0) {
                const { elbow, text } = placement(a.position, centre, radius, style.leaderLength, i);
                textAt = text;
                // Dash density, not dash count: the two segments of one leader have very
                // different lengths, and a fixed count would make one of them all gaps.
                const dashesFor = (p: Vec3, q: Vec3) => Math.max(2, Math.round((Vec3.distance(p, q) / 4) * style.leaderDashes));
                lines.push(
                    { a: [a.position[0], a.position[1], a.position[2]] as Point, b: [elbow[0], elbow[1], elbow[2]] as Point, color: style.leaderColor, radius: style.leaderWidth, dashes: dashesFor(a.position, elbow), label: a.text, owners },
                    { a: [elbow[0], elbow[1], elbow[2]] as Point, b: [text[0], text[1], text[2]] as Point, color: style.leaderColor, radius: style.leaderWidth, dashes: dashesFor(elbow, text), label: a.text, owners },
                );
            }
            texts.push({ at: [textAt[0], textAt[1], textAt[2]] as Point, text: a.text, owners });
        }
        if (lines.length) await setOverlay(viewer, LEADER_OVERLAY, { lines }, 'Guias dos rótulos');
        await setTextOverlay(viewer, TEXT_OVERLAY, texts, {
            color: style.color,
            size: style.size,
            background: style.background,
            backgroundColor: style.backgroundColor,
            backgroundOpacity: style.backgroundOpacity,
            border: style.outline ? 0.25 : 0,
        });
        return ok(list.length);
    } catch (e) {
        return err(`Falha ao rotular: ${errorMessage(e)}`);
    }
}

/** Removes the labels and their leaders — including the residue labels the focus view adds. */
export async function clearLabels(viewer: Viewer): Promise<void> {
    await clearOverlay(viewer, LEADER_OVERLAY);
    await clearOverlay(viewer, TEXT_OVERLAY);
    const labels = viewer.plugin.managers.structure.measurement.state.labels;
    if (labels.length === 0) return;
    const builder = viewer.plugin.build();
    for (const l of labels) builder.delete(l.transform.ref);
    await builder.commit();
}

