/**
 * Domain vocabulary for the engine layer.
 *
 * Nothing here imports from 'molstar/*' — these are the only types the React layer
 * sees. Mol* objects never cross this boundary.
 */

declare const structureIdBrand: unique symbol;
/** Opaque handle to a loaded structure. Only the engine mints one. */
export type StructureId = string & { readonly [structureIdBrand]: 'StructureId' };

export function asStructureId(raw: string): StructureId {
    return raw as StructureId;
}

/** Engine calls never throw — the UI shows the failure without unmounting the canvas. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: string): Result<T> => ({ ok: false, error });

export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    return 'Erro desconhecido';
}

export type StructureFormat = 'pdb' | 'mmcif' | 'bcif';

/** How a chain is used in the complex. Set by heuristic, overridable by the user. */
export type ChainRole = 'binder' | 'target' | 'mhc' | 'b2m' | 'peptide' | 'ligand' | 'unassigned';

/** One polymer residue, as the sequence track draws it. */
export interface ResidueInfo {
    /** auth_seq_id */
    seq: number;
    insCode: string;
    /** One-letter code, 'X' for non-standard. */
    code: string;
    /** Three-letter name. */
    name: string;
}

export interface ChainInfo {
    /** auth_asym_id — the letter the user sees in PyMOL/ChimeraX and in the file. */
    authAsymId: string;
    /** label_asym_id of the polymer unit — what Mol* selections key on internally. */
    labelAsymId: string;
    residueCount: number;
    isPolymer: boolean;
    role: ChainRole;
    /** User-given display name ("Binder 7", "HLA-A2"); empty = show the chain letter. */
    alias: string;
    residues: ResidueInfo[];
}

export interface StructureInfo {
    id: StructureId;
    /** File name or accession, as loaded. */
    name: string;
    /** User-given display name; empty = use `name`. */
    alias: string;
    source: 'file' | 'pdb' | 'alphafold';
    /** Absolute path for files opened from disk. */
    path: string | null;
    format: StructureFormat;
    chains: ChainInfo[];
    residueCount: number;
    atomCount: number;
    /** Hydrogens in the file — zero for most models, which is when "add hydrogens" matters. */
    hydrogenCount: number;
    modelCount: number;
    /** Model index currently shown (0-based) for multi-model files. */
    modelIndex: number;
    /** True when B-factors look like AlphaFold pLDDT. */
    looksLikePlddt: boolean;
    /** B-factor range over all atoms, for the ramp controls. */
    bfactorRange: [number, number];
    visible: boolean;
}

export function displayName(info: Pick<StructureInfo, 'alias' | 'name'>): string {
    return info.alias || info.name;
}

/**
 * ChimeraX's display model: every residue has three independent layers — ribbon,
 * atoms, surface. Styling one never touches the others.
 */
export type Layer = 'ribbon' | 'atoms' | 'surface';
export type RibbonStyle = 'cartoon' | 'tube' | 'backbone' | 'putty';
export type AtomStyle = 'sticks' | 'ball-and-stick' | 'spheres' | 'lines';
export type SurfaceStyle = 'molecular' | 'gaussian';
export type LayerStyle =
    | { layer: 'ribbon'; style: RibbonStyle }
    | { layer: 'atoms'; style: AtomStyle; size: number }
    | { layer: 'surface'; style: SurfaceStyle; opacity: number };

/** What a styling action applies to. */
export type StyleTarget =
    | { kind: 'selection' }
    | { kind: 'structure'; id: StructureId }
    | { kind: 'chain'; id: StructureId; chain: string };

export type PickLevel = 'atom' | 'residue' | 'chain';
export type SelectModifier = 'set' | 'add' | 'remove' | 'intersect';

export type ResidueClass =
    | 'hydrophobic'
    | 'charged'
    | 'positive'
    | 'negative'
    | 'polar'
    | 'aromatic'
    | 'gly-pro'
    | 'helix'
    | 'sheet'
    | 'loop'
    | 'ligand'
    | 'water'
    | 'disulfide'
    | 'backbone'
    | 'sidechain';

export interface SelectionSummary {
    residues: number;
    atoms: number;
    /** "1AO7:B" labels for every chain touched by the selection. */
    chains: string[];
    label: string;
}

/** Residues selected per chain — drives the sequence track highlight. */
export type SelectedResidues = Map<StructureId, Map<string, Set<string>>>;

export function residueKey(seq: number, insCode: string): string {
    return insCode ? `${seq}${insCode}` : String(seq);
}

export type ColorScheme =
    | 'chain'
    | 'entity'
    | 'uniform'
    | 'secondary-structure'
    | 'element'
    | 'b-factor'
    | 'plddt'
    | 'hydrophobicity'
    | 'residue-charge'
    | 'rainbow'
    | 'residue-name'
    | 'role'
    | 'data';

export type RampId = 'viridis' | 'cividis' | 'magma' | 'inferno' | 'blue-white-red' | 'red-white-blue' | 'white-red' | 'white-blue';

export interface ColorSettings {
    scheme: ColorScheme;
    /** Uniform colour, 0xRRGGBB. */
    uniform: number;
    ramp: RampId;
    /** Fixed domain for continuous schemes; null = automatic from data. */
    domain: [number, number] | null;
    /** Carbons keep the scheme colour, heteroatoms by element (ChimeraX default). */
    heteroatomsByElement: boolean;
    /** Residue dataset shown by the 'data' scheme. */
    dataset: string | null;
    /** Residues without a value: neutral grey, or their chain colour. */
    dataFallback: 'neutral' | 'chain';
}

/**
 * Per-residue values from a computation (Rosetta ΔG, ΔSASA, ΔΔG, pydssp, MHCXGraph
 * correspondences…), keyed 'A:45' / 'A:45A'.
 */
export interface ResidueDataset {
    id: string;
    label: string;
    /** Where it came from, shown in the legend ("Rosetta · ref2015"). */
    source: string;
    kind: 'continuous' | 'categorical' | 'explicit';
    values: Record<string, number | string>;
    ramp?: RampId;
    /** Continuous domain; null = data range. */
    domain?: [number, number] | null;
    /** Categorical value → colour, or explicit residue → colour. */
    colors?: Record<string, number>;
    unit?: string;
}

export type CameraProjection = 'orthographic' | 'perspective';

// ---------------------------------------------------------------------------
// Look: lighting, materials, effects and background as one value
// ---------------------------------------------------------------------------

/** Ready-made looks, named by intent (docs/PLAN.md, Fase 3). */
export type LookPreset =
    | 'soft'
    | 'chimerax-soft'
    | 'white-figure'
    | 'illustrative'
    | 'glossy'
    | 'clay'
    | 'poster-dark'
    | 'cinematic'
    | 'flat'
    | 'raytraced';

export interface LookLight {
    /** Degrees from the view axis, 0–180 (Mol*'s convention: 180 = from behind the camera). */
    inclination: number;
    /** Degrees around the view axis, 0–360. */
    azimuth: number;
    color: number;
    intensity: number;
}

/** Mol*'s PBR-ish material: roughness 1 is ChimeraX "dull", low roughness is "shiny". */
export interface LayerMaterial {
    metalness: number;
    roughness: number;
    bumpiness: number;
}

/**
 * Background as two colours plus a kind, so any two backgrounds can be blended
 * during a transition. solid/transparent use `a`; vertical: a = top, b = bottom;
 * radial: a = centre, b = edge.
 */
export interface LookBackground {
    kind: 'solid' | 'transparent' | 'vertical' | 'radial';
    a: number;
    b: number;
}

export interface Look {
    ambient: number;
    ambientColor: number;
    lights: LookLight[];
    exposure: number;
    /** Ambient-occlusion strength; 0 = off. */
    occlusion: number;
    /** Ambient-occlusion reach in Å. */
    occlusionReach: number;
    /** Several occlusion radii at once: crevices and the large-scale shape both read. */
    occlusionMultiScale: boolean;
    /** Screen-space shadow reach in Å; 0 = off. */
    shadows: number;
    /** Silhouette width in px; 0 = off. */
    outline: number;
    outlineColor: number;
    /** Depth jump that counts as an edge, 0–1. */
    outlineThreshold: number;
    /** Depth cue (fog); 0 = off, up to 100. */
    fog: number;
    /** Depth-of-field blur kernel; 0 = off. */
    dof: number;
    /** Depth kept in focus around the camera target, Å. */
    dofRange: number;
    /** Glow of bright highlights; 0 = off. */
    bloom: number;
    /** Contrast-adaptive sharpening; 0 = off. */
    sharpen: number;
    /** Path-traced global illumination (Mol* "illumination"), progressive while idle. */
    illumination: boolean;
    giBounces: number;
    /** Toon shading in bands. */
    celShaded: boolean;
    material: Record<Layer, LayerMaterial>;
    background: LookBackground;
}

export interface ChainRef {
    structureId: StructureId;
    chain: string;
}

export type SuperposeMethod = 'sequence' | 'structure';

export interface ResiduePair {
    reference: string;
    mobile: string;
    distance: number;
    usedInFit: boolean;
}

/** How far a chain pair sits apart in the coordinates currently displayed. */
export interface ChainDeviation {
    reference: ChainRef;
    mobile: ChainRef;
    /** RMSD over the aligned pairs, Å; null when it could not be measured. */
    rmsd: number | null;
    alignedPairs: number;
    identity: number;
    maxDeviation: number | null;
    note: string;
}

export interface SuperposeReport {
    method: SuperposeMethod;
    reference: ChainRef;
    mobile: ChainRef;
    rmsd: number;
    rmsdAllPairs: number;
    fitPairs: number;
    alignedPairs: number;
    sequenceIdentity: number;
    tmScore: number | null;
    pairs: ResiduePair[];
}

// ---------------------------------------------------------------------------
// Interface interactions
// ---------------------------------------------------------------------------

export type InteractionKind =
    | 'hydrogen-bond'
    | 'weak-hydrogen-bond'
    | 'salt-bridge'
    | 'pi-stacking'
    | 'cation-pi'
    | 'halogen-bond'
    | 'hydrophobic'
    | 'metal';

export interface ResidueRef {
    structureId: StructureId;
    chain: string;
    seq: number;
    insCode: string;
    name: string;
    /** Atom names involved on this side (for H-bonds, the donor/acceptor). */
    atoms: string[];
}

export interface InteractionRecord {
    kind: InteractionKind;
    a: ResidueRef;
    b: ResidueRef;
    /** Distance between the interacting features, Å. */
    distance: number;
    /** Feature positions in the displayed (possibly superposed) frame. */
    posA: [number, number, number];
    posB: [number, number, number];
}

/** One side of an interface: chains of one structure. */
export interface InterfaceSide {
    structureId: StructureId;
    chains: string[];
}

export interface InterfaceResidue extends ResidueRef {
    /** Atoms of this residue within the cutoff of the other side. */
    contactAtoms: number;
}

export interface InterfaceReport {
    sideA: InterfaceSide;
    sideB: InterfaceSide;
    contacts: { cutoff: number; minAtoms: number; includeHydrogens: boolean };
    interactions: InteractionRecord[];
    /** Interfacial residues per side (contact criterion above). */
    residuesA: InterfaceResidue[];
    residuesB: InterfaceResidue[];
    /** Atom pairs within the cutoff. */
    atomContacts: number;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export type MeasureKind = 'distance' | 'angle' | 'dihedral';

export interface MeasurementInfo {
    ref: string;
    kind: MeasureKind;
    label: string;
    /** The atoms picked, in order. */
    atoms: string[];
    /** Å for a distance, degrees for an angle or dihedral. */
    value: number;
    unit: string;
}
