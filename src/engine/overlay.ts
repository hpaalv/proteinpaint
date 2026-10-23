/**
 * Overlays: dashed/solid cylinders between points and spheres at points, built as a
 * single Mol* mesh per overlay (one draw call on the GPU, whatever the count).
 *
 * Each overlay has a tag, so the Mol* interactions of the interface panel, the
 * Rosetta H-bonds and the buried unsatisfied polars can be shown, replaced or hidden
 * independently.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import { Task } from 'molstar/lib/mol-task';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh';
import { MeshBuilder } from 'molstar/lib/mol-geo/geometry/mesh/mesh-builder';
import { addFixedCountDashedCylinder, addSimpleCylinder } from 'molstar/lib/mol-geo/geometry/mesh/builder/cylinder';
import { addSphere } from 'molstar/lib/mol-geo/geometry/mesh/builder/sphere';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder';
import { Shape } from 'molstar/lib/mol-model/shape';
import { PluginStateObject as SO, PluginStateTransform } from 'molstar/lib/mol-plugin-state/objects';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { Color } from 'molstar/lib/mol-util/color';
import type { Viewer } from './viewer';

export type Point = [number, number, number];

export interface OverlayLine {
    a: Point;
    b: Point;
    color: number;
    radius: number;
    /** 1 = solid. */
    dashes: number;
    label: string;
    /** Structures this line belongs to; closing any of them removes it. */
    owners?: string[];
}

export interface OverlaySphere {
    at: Point;
    color: number;
    radius: number;
    label: string;
    owners?: string[];
}

interface OverlayData {
    lines: OverlayLine[];
    spheres: OverlaySphere[];
    alpha: number;
    /** Structures the whole overlay belongs to (on top of per-item owners). */
    owners?: string[];
}

const OverlayShape = PluginStateTransform.BuiltIn({
    name: 'pp-overlay',
    display: 'Overlay',
    from: SO.Root,
    to: SO.Shape.Provider,
    params: {
        data: PD.Value<OverlayData>({ lines: [], spheres: [], alpha: 1 }, { isHidden: true }),
        label: PD.Text('Overlay'),
    },
})({
    canAutoUpdate() {
        return true;
    },
    apply({ params }) {
        return Task.create('Overlay', async () => {
            const label = params.label;
            return new SO.Shape.Provider(
                {
                    label,
                    data: params.data,
                    params: { ...Mesh.Params, alpha: PD.Numeric(params.data.alpha) },
                    geometryUtils: Mesh.Utils,
                    getShape: (_, data: OverlayData) => {
                        const n = data.lines.length + data.spheres.length;
                        const state = MeshBuilder.createState(Math.max(256, n * 160), 2048);
                        const a = Vec3();
                        const b = Vec3();
                        data.lines.forEach((line, i) => {
                            state.currentGroup = i;
                            Vec3.set(a, ...line.a);
                            Vec3.set(b, ...line.b);
                            const props = { radiusTop: line.radius, radiusBottom: line.radius, radialSegments: 12, topCap: true, bottomCap: true };
                            if (line.dashes <= 1) addSimpleCylinder(state, a, b, props);
                            else addFixedCountDashedCylinder(state, a, b, 1, line.dashes, true, props);
                        });
                        data.spheres.forEach((s, j) => {
                            state.currentGroup = data.lines.length + j;
                            addSphere(state, Vec3.create(...s.at), s.radius, 2);
                        });
                        const mesh = MeshBuilder.getMesh(state);
                        const colorOf = (g: number) => (g < data.lines.length ? data.lines[g]?.color : data.spheres[g - data.lines.length]?.color) ?? 0xffffff;
                        const labelOf = (g: number) => (g < data.lines.length ? data.lines[g]?.label : data.spheres[g - data.lines.length]?.label) ?? '';
                        return Shape.create(label, data, mesh, (g) => Color(colorOf(g)), () => 1, (g) => labelOf(g));
                    },
                },
                { label },
            );
        });
    },
});

/**
 * Free-standing text in 3D.
 *
 * Mol*'s own label offsets move the glyphs in screen space, so a label can never be
 * pinned to a point the camera does not know about. Text drawn here sits at a world
 * position, which is what lets a leader line actually end at its label.
 */
export interface OverlayText {
    at: Point;
    text: string;
    owners?: string[];
}

export interface TextOverlayStyle {
    color: number;
    /** World-space height. */
    size: number;
    background: boolean;
    backgroundColor: number;
    backgroundOpacity: number;
    /** Glyph outline width, 0 = none. */
    border: number;
}

interface TextOverlayData extends TextOverlayStyle {
    items: OverlayText[];
    owners?: string[];
}

const TextOverlayShape = PluginStateTransform.BuiltIn({
    name: 'pp-text-overlay',
    display: 'Text overlay',
    from: SO.Root,
    to: SO.Shape.Provider,
    params: {
        data: PD.Value<TextOverlayData>({ items: [], color: 0xffffff, size: 2, background: false, backgroundColor: 0, backgroundOpacity: 0.7, border: 0.2 }, { isHidden: true }),
        label: PD.Text('Text'),
    },
})({
    canAutoUpdate() {
        return true;
    },
    apply({ params }) {
        return Task.create('Text overlay', async () => {
            const label = params.label;
            const d = params.data;
            return new SO.Shape.Provider(
                {
                    label,
                    data: d,
                    params: {
                        ...Text.Params,
                        background: PD.Boolean(d.background),
                        backgroundColor: PD.Color(Color(d.backgroundColor)),
                        backgroundOpacity: PD.Numeric(d.backgroundOpacity),
                        backgroundMargin: PD.Numeric(0.25),
                        borderWidth: PD.Numeric(d.border),
                        borderColor: PD.Color(Color(0x000000)),
                        attachment: PD.Select('middle-center', Text.Params.attachment.options),
                    },
                    geometryUtils: Text.Utils,
                    getShape: (_, data: TextOverlayData) => {
                        const builder = TextBuilder.create({ ...PD.getDefaultValues(Text.Params), background: data.background }, data.items.length, data.items.length / 2);
                        data.items.forEach((item, i) => {
                            builder.add(item.text, item.at[0], item.at[1], item.at[2], 0, 1, i);
                        });
                        const text = builder.getText();
                        return Shape.create(label, data, text, () => Color(data.color), () => data.size, (g) => data.items[g]?.text ?? '');
                    },
                },
                { label },
            );
        });
    },
});

const tagOf = (name: string) => `pp-overlay:${name}`;

async function removeTag(plugin: PluginContext, tag: string): Promise<void> {
    const nodes = plugin.state.data.selectQ((q) => q.root.subtree().withTag(tag));
    if (nodes.length === 0) return;
    const builder = plugin.build();
    for (const n of nodes) builder.delete(n.transform.ref);
    await builder.commit();
}

/** Replaces the overlay `name` (empty content removes it). */
export async function setOverlay(viewer: Viewer, name: string, content: { lines?: OverlayLine[]; spheres?: OverlaySphere[]; alpha?: number; owners?: string[] }, label = 'Overlay'): Promise<void> {
    const plugin = viewer.plugin;
    const tag = tagOf(name);
    await removeTag(plugin, tag);
    const data: OverlayData = { lines: content.lines ?? [], spheres: content.spheres ?? [], alpha: content.alpha ?? 1, owners: content.owners };
    if (data.lines.length + data.spheres.length === 0) return;
    await plugin
        .build()
        .toRoot()
        .apply(OverlayShape, { data, label }, { tags: tag })
        .apply(StateTransforms.Representation.ShapeRepresentation3D, {}, { tags: tag })
        .commit();
}

/** Text pinned to world positions; replaces whatever that overlay held. */
export async function setTextOverlay(viewer: Viewer, name: string, items: OverlayText[], style: TextOverlayStyle & { owners?: string[] }, label = 'Rótulos'): Promise<void> {
    const plugin = viewer.plugin;
    const tag = tagOf(name);
    await removeTag(plugin, tag);
    if (items.length === 0) return;
    await plugin
        .build()
        .toRoot()
        .apply(TextOverlayShape, { data: { ...style, items }, label }, { tags: tag })
        .apply(StateTransforms.Representation.ShapeRepresentation3D, {}, { tags: tag })
        .commit();
}

export function clearOverlay(viewer: Viewer, name: string): Promise<void> {
    return removeTag(viewer.plugin, tagOf(name));
}

export function setOverlayVisible(viewer: Viewer, name: string, visible: boolean): void {
    const plugin = viewer.plugin;
    for (const n of plugin.state.data.selectQ((q) => q.root.subtree().withTag(tagOf(name)))) {
        viewer.setHidden(n.transform.ref, !visible);
    }
}

/**
 * Drops what a closed structure left on screen: overlays owned by it as a whole go,
 * and mixed overlays (labels over two structures) keep only the items of the others.
 * Overlays live under the state root, not under a structure, so deleting the
 * structure alone would leave its leaders, labels and interaction lines floating.
 */
export async function pruneOverlays(viewer: Viewer, owner: string): Promise<void> {
    const plugin = viewer.plugin;
    const owned = (x: { owners?: string[] }) => x.owners?.includes(owner) ?? false;
    const builder = plugin.build();
    let changed = false;
    for (const cell of plugin.state.data.selectQ((q) => q.root.subtree())) {
        const t = cell.transform;
        if (t.transformer !== OverlayShape && t.transformer !== TextOverlayShape) continue;
        // Deleting the shape node takes its representation (the child) with it.
        const shapeRef = t.ref;
        if (t.transformer === OverlayShape) {
            const data = (t.params as { data: OverlayData }).data;
            const lines = data.lines.filter((l) => !owned(l));
            const spheres = data.spheres.filter((x) => !owned(x));
            if (owned(data) || lines.length + spheres.length === 0) builder.delete(shapeRef);
            else if (lines.length !== data.lines.length || spheres.length !== data.spheres.length) builder.to(shapeRef).update(OverlayShape, (old) => ({ ...old, data: { ...data, lines, spheres } }));
            else continue;
        } else {
            const data = (t.params as { data: TextOverlayData }).data;
            const items = data.items.filter((x) => !owned(x));
            if (owned(data) || items.length === 0) builder.delete(shapeRef);
            else if (items.length !== data.items.length) builder.to(shapeRef).update(TextOverlayShape, (old) => ({ ...old, data: { ...data, items } }));
            else continue;
        }
        changed = true;
    }
    if (changed) await builder.commit();
}
