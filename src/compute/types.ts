/**
 * Shapes of what ppcore/tools/*.py return, and the parameters each tool accepts with
 * the same defaults as the Python side. The forms in ui/analysis read DEFAULTS.
 */

export type ToolId = 'rosetta_interface' | 'rosetta_relax' | 'dssp' | 'tmalign' | 'electrostatics' | 'kvfinder' | 'mhcxgraph' | 'mhcx_renumber' | 'hydrogens';

export interface ResidueAtom {
    key: string;
    chain: string;
    seq: number;
    icode: string;
    name: string;
    atom: string;
}

export interface RosettaInterfaceResult {
    input: string;
    interface: string;
    side_a: string[];
    side_b: string[];
    scorefxn: string;
    metrics: Record<string, number | null>;
    hbonds: { donor: ResidueAtom & { hydrogen: string }; acceptor: ResidueAtom; energy: number; distance_HA: number; distance_DA: number; type: string }[];
    unsats: (ResidueAtom & { kind: string; origin: 'interface' | 'preexisting'; sasa_complex: number; sasa_separated: number; backbone: boolean })[];
    per_residue: { dG?: Record<string, number>; dSASA?: Record<string, number>; total_energy?: Record<string, number> };
    pair_energies: { a: string; a_name: string; b: string; b_name: string; energy: number }[];
    alanine_scan: { key: string; name: string; ddG: number; dG_wt: number; dG_mut: number }[];
    seconds: number;
}

export interface RelaxResult {
    input: string;
    relaxed_path: string;
    scorefxn: string;
    score_before: number;
    score_after: number;
    ca_rmsd: number;
    all_atom_rmsd: number;
    movable_residues: number;
    seed: number;
    interface: { dG_separated: number; dSASA: number; sc_value: number; interface_hbonds: number; delta_unsat_hbonds: number } | null;
    seconds: number;
}

export interface DsspResult {
    input: string;
    device: string;
    ss: Record<string, string>;
    chains: { chain: string; length: number; helix: number; strand: number; loop: number; string: string }[];
    hbond_map: Record<string, [string, string, number][]>;
}

export interface TmalignResult {
    reference: { input: string; chains: string[] };
    mobile: { input: string; chains: string[] };
    length_reference: number;
    length_mobile: number;
    aligned_length: number;
    rmsd: number;
    seq_identity: number;
    tm_reference: number;
    tm_mobile: number;
    tm_average: number | null;
    tm_custom: number | null;
    alignment: { mobile: string; markers: string; reference: string };
    rotation: number[][];
    translation: number[];
}

export interface ElectrostaticsResult {
    input: string;
    dx_path: string;
    pqr_path: string;
    net_charge: number;
    grid: { dime: number[]; fglen: number[]; cglen: number[]; spacing: number[] };
    forcefield: string;
    ph: number;
    ionic_strength: number;
}

export interface Cavity {
    tag: string;
    volume: number;
    area: number;
    max_depth: number | null;
    avg_depth: number | null;
    avg_hydropathy: number | null;
    residues: { key: string; chain: string; seq: string; name: string }[];
    frequencies: { RESIDUES?: Record<string, number>; CLASS?: Record<string, number> };
    openings: Record<string, number>;
}

export interface KvfinderResult {
    input: string;
    region: string;
    receptor_chains: string[];
    ligand_chains: string[];
    n: number;
    cavities: Cavity[];
    points_path: string | null;
    n_points: number;
    hydropathy_range: [number, number] | null;
    scale: string;
    step: number;
    total_volume: number;
}

export interface MhcxMapping {
    model_idx: number;
    chain: string;
    resn: string;
    resi: number | string;
    rsa: number | null;
}

export interface MhcxNode {
    id: number;
    label: string;
    title: string;
    group: string;
    mapping: MhcxMapping[];
}

export interface MhcxComparison {
    key: string;
    nodes: MhcxNode[];
    edges: { id: number; from: number; to: number; std: number | null; title: string; raw_dist: number }[];
    components: { id: number; node_ids: number[]; frames: { id: number; node_ids: number[]; rmsds: number[] | null }[] }[];
    summary: Record<string, number | string>[];
    per_protein: Record<string, number | string>[];
}

export interface MhcxResult {
    mode: 'multiple' | 'pairwise' | 'screening';
    proteins: string[];
    inputs: string[];
    /** names[i] = protein name MHCXGraph gave to the i-th submitted structure. */
    names: string[];
    reference: string | null;
    comparisons: MhcxComparison[];
    filtered_graphs: Record<string, { nodes: MhcxNode[]; edges: MhcxComparison['edges'] }>;
    dashboard: string | null;
    output_dir: string;
    heatmap: { png: string; distance: { labels: string[]; values: number[][] }; components: Record<string, number | string>[] } | null;
    settings: Record<string, unknown>;
}

export interface RenumberResult {
    mhc_class: string;
    results: { input: string; output: string | null; ok: boolean; error?: string }[];
    output_dir: string;
}

// ---------------------------------------------------------------------------
// Parameters (defaults identical to the Python side)
// ---------------------------------------------------------------------------

export const ROSETTA_INTERFACE_DEFAULTS = {
    scorefxn: 'ref2015',
    pack_separated: true,
    pack_input: false,
    pack_rounds: 1,
    compute_sc: true,
    calc_hbond_sasaE: true,
    compute_packstat: false,
    packstat_oversample: 30,
    cms: true,
    cms_distance_weight: 0.5,
    cms_filtered_area: 0,
    cms_quick: false,
    cms_use_rosetta_radii: false,
    hbonds: true,
    hbond_energy_cutoff: -0.25,
    hbond_include_bb: true,
    unsats: true,
    unsat_probe: 1.0,
    unsat_burial_sasa: 0.5,
    unsat_hbond_cutoff: -0.25,
    unsat_include_preexisting: false,
    per_residue: true,
    pair_energies: true,
    pair_energy_cutoff: -1.0,
    pair_neighbor_distance: 10,
    alanine_scan: false,
    ala_side: 'A',
    ala_min_dsasa: 10,
    ala_repack_radius: 8,
    remove_hetero: true,
    remove_waters: true,
    extra_flags: '',
    timeout_min: 30,
};

export const RELAX_DEFAULTS = {
    scorefxn: 'ref2015',
    repeats: 5,
    cartesian: false,
    constrain_to_start: false,
    cst_stdev: 0.5,
    ramp_constraints: true,
    bb: true,
    chi: true,
    jump: true,
    region: 'all',
    interface_radius: 8,
    analyze_interface: true,
    nstruct: 1,
    load: 'best',
    remove_hetero: true,
    remove_waters: true,
    extra_flags: '',
    timeout_min: 120,
};

export const DSSP_DEFAULTS = { device: 'auto', hbond_map: false, hbond_cutoff: 0.5 };

export const TMALIGN_DEFAULTS = {
    normalize: 'reference',
    custom_length: 0,
    d0: 0,
    circular_permutation: false,
    fast: false,
    mirror: false,
    byresi: false,
    merge_chains: false,
    apply: true,
};

export const ELECTROSTATICS_DEFAULTS = {
    forcefield: 'PARSE',
    ph: 7.4,
    titration: 'propka',
    pdb2pqr_debump: true,
    pdb2pqr_optimize_hbonds: true,
    ionic_strength: 0.15,
    cation_radius: 2.0,
    anion_radius: 1.8,
    pdie: 2.0,
    sdie: 78.54,
    equation: 'lpbe',
    boundary: 'sdh',
    surface: 'smol',
    charge_discretization: 'spl2',
    srad: 1.4,
    swin: 0.3,
    sdens: 10,
    temperature: 298.15,
    grid_spacing: 0.5,
    grid_margin: 0.2,
    coarse_factor: 1.7,
    min_dime: 33,
    timeout_min: 30,
};

export const KVFINDER_DEFAULTS = {
    region: 'all',
    ligand_cutoff: 5.0,
    box_padding: 3.5,
    step: 0.6,
    probe_in: 1.4,
    probe_out: 4.0,
    removal_distance: 2.4,
    volume_cutoff: 5.0,
    surface: 'SES',
    ignore_backbone: false,
    include_depth: true,
    include_hydropathy: true,
    hydrophobicity_scale: 'EisenbergWeiss',
    openings: true,
    openings_cutoff: 1,
    remove_waters: true,
    remove_hetero: true,
};

export const MHCX_SETTINGS_DEFAULTS = {
    run_mode: 'multiple',
    reference_structure: null as number | null,
    node_granularity: 'all_atoms',
    edge_threshold: 8.5,
    include_ligands: true,
    include_noncanonical_residues: true,
    include_waters: true,
    filter_triads_by_chain: null as string[] | null,
    max_gap_helix: 0,
    distance_bin_width: 2.0,
    local_distance_diff_threshold: 1.0,
    global_distance_diff_threshold: 2.0,
    close_tolerance: 0.1,
    rsa_filter: 0.1,
    asa_filter: 5,
    triad_rsa: false,
    rsa_bin_width: 0.3,
    rsa_diff_threshold: 0.3,
    close_tolerance_rsa: 0.01,
    max_chunks: 5,
    show_std_edges: false,
    output_structures: false,
};

export type Params<T> = { -readonly [K in keyof T]: T[K] };

export interface HydrogensResult {
    output: string;
    hydrogens: number;
    heavy_atoms: number;
    ph: number;
    propka: boolean;
    ligands_kept: string[];
    residues_dropped: string[];
}
