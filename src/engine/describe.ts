/**
 * Turns a Mol* Structure into the metadata the UI consumes: chains with their
 * residues (sequence track), the chain-role heuristic and data ranges.
 *
 * The only place that walks the atomic hierarchy for description. If that API
 * changes shape, this file is the blast radius.
 */

import { Structure, StructureElement, StructureProperties as P, Unit } from 'molstar/lib/mol-model/structure';
import { getProteinOneLetterCode } from 'molstar/lib/mol-model/sequence/constants';
import type { ChainInfo, ChainRole, ResidueInfo, StructureFormat, StructureId, StructureInfo } from './types';

/** Residue-count windows of a class-I pMHC complex. */
const PMHC = {
    heavyChain: { min: 175, max: 300 },
    b2m: { min: 85, max: 110 },
    peptide: { min: 7, max: 15 },
} as const;

const inRange = (n: number, r: { min: number; max: number }) => n >= r.min && n <= r.max;

interface RawChain {
    authAsymId: string;
    labelAsymId: string;
    residues: ResidueInfo[];
    isPolymer: boolean;
}

const NUCLEIC: Record<string, string> = { DA: 'A', DC: 'C', DG: 'G', DT: 'T', DU: 'U', A: 'A', C: 'C', G: 'G', U: 'U' };

function oneLetter(name: string): string {
    const code = getProteinOneLetterCode(name);
    if (code !== 'X') return code;
    return NUCLEIC[name] ?? 'X';
}

/**
 * Mol* splits one auth chain into several units (polymer, waters, ligands) sharing
 * the auth_asym_id. Only polymer residues are listed; `polymerElements` holds one
 * trace atom per polymer residue, so this never walks every atom.
 */
function collectChains(structure: Structure): RawChain[] {
    const loc = StructureElement.Location.create(structure);
    const byAuth = new Map<string, RawChain>();
    // Symmetry copies share units' chain ids; describe the asymmetric unit only once.
    const seenUnitKeys = new Set<string>();

    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit) || unit.elements.length === 0) continue;
        loc.unit = unit;
        loc.element = unit.elements[0]!;
        const authAsymId = P.chain.auth_asym_id(loc);
        const labelAsymId = P.chain.label_asym_id(loc);
        const key = `${unit.invariantId}:${labelAsymId}`;
        if (seenUnitKeys.has(key)) continue;
        seenUnitKeys.add(key);

        let chain = byAuth.get(authAsymId);
        if (!chain) {
            chain = { authAsymId, labelAsymId, residues: [], isPolymer: false };
            byAuth.set(authAsymId, chain);
        }

        const poly = unit.polymerElements;
        if (poly.length > 0) {
            if (!chain.isPolymer) {
                chain.isPolymer = true;
                chain.labelAsymId = labelAsymId;
            }
            for (let i = 0; i < poly.length; i++) {
                loc.element = poly[i]!;
                const name = P.atom.label_comp_id(loc);
                chain.residues.push({
                    seq: P.residue.auth_seq_id(loc),
                    insCode: P.residue.pdbx_PDB_ins_code(loc) || '',
                    code: oneLetter(name),
                    name,
                });
            }
        }
    }
    return [...byAuth.values()];
}

/**
 * Reference sequences for recognising pMHC components by sequence rather than by
 * length alone — designed binders (60–110 aa) fall inside the β2m length window.
 * Human and mouse β2m; HLA-A*02:01 and H-2Kb α1α2(α3) as class-I heavy-chain probes.
 */
const B2M_REFS = [
    'IQRTPKIQVYSRHPAENGKSNFLNCYVSGFHPSDIEVDLLKNGERIEKVEHSDLSFSKDWSFYLLYYTEFTPTEKDEYACRVNHVTLSQPKIVKWDRDM',
    'IQKTPQIQVYSRHPPENGKPNILNCYVTQFHPPHIEIQMLKNGKKIPKVEMSDMSFSKDWSFYILAHTEFTPTETDTYACRVKHASMAEPKTVYWDRDM',
];
const MHC_I_REFS = [
    'GSHSMRYFFTSVSRPGRGEPRFIAVGYVDDTQFVRFDSDAASQRMEPRAPWIEQEGPEYWDGETRKVKAHSQTHRVDLGTLRGYYNQSEAGSHTVQRMYGCDVGSDWRFLRGYHQYAYDGKDYIALKEDLRSWTAADMAAQTTKHKWEAAHVAEQLRAYLEGTCVEWLRRYLENGKETLQRT',
    'GPHSLRYFVTAVSRPGLGEPRYMEVGYVDDTEFVRFDSDAENPRYEPRARWMEQEGPEYWERETQKAKGNEQSFRVDLRTLLGYYNQSKGGSHTIQVISGCEVGSDGRLLRGYQQYAYDGCDYIALNEDLKTWTAADMAALITKHKWEQAGEAERLRAYLEGTCVEWLRRYLKNGNATLLRT',
];

function kmers(seq: string, k = 5): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i + k <= seq.length; i++) out.add(seq.slice(i, i + k));
    return out;
}
const B2M_KMERS = B2M_REFS.map((r) => kmers(r));
const MHC_KMERS = MHC_I_REFS.map((r) => kmers(r));

/** Fraction of the chain's 5-mers found in the best-matching reference. */
function similarity(seq: string, refs: Set<string>[]): number {
    const own = kmers(seq);
    if (own.size === 0) return 0;
    let best = 0;
    for (const ref of refs) {
        let hit = 0;
        for (const k of own) if (ref.has(k)) hit++;
        best = Math.max(best, hit / own.size);
    }
    return best;
}

/**
 * Roles, most specific evidence first:
 *   1. sequence: β2m and class-I heavy chain recognised by 5-mer overlap with references;
 *   2. a 7–15 aa chain next to an MHC is the presented peptide;
 *   3. everything else in an MHC complex is the binder;
 *   4. no MHC found: the shortest polymer chain is the binder, the rest the target.
 * All guesses — the user can override them, and they feed interface analysis.
 */
function assignRoles(chains: RawChain[]): ChainRole[] {
    const polymers = chains.filter((c) => c.isPolymer);
    const roles = new Map<string, ChainRole>();
    const seqOf = (c: RawChain) => c.residues.map((r) => r.code).join('');
    const len = (c: RawChain) => c.residues.length;

    for (const c of polymers) {
        const seq = seqOf(c);
        if (inRange(len(c), { min: 85, max: 120 }) && similarity(seq, B2M_KMERS) > 0.3) roles.set(c.authAsymId, 'b2m');
        else if (len(c) >= 150 && similarity(seq, MHC_KMERS) > 0.15) roles.set(c.authAsymId, 'mhc');
    }
    const hasMhc = [...roles.values()].includes('mhc');
    if (hasMhc) {
        for (const c of polymers) {
            if (roles.has(c.authAsymId)) continue;
            roles.set(c.authAsymId, inRange(len(c), PMHC.peptide) ? 'peptide' : 'binder');
        }
    } else if (polymers.length >= 2) {
        // Length fallback for MHC-like targets (MR1, CD1, FcRn…) the probes do not cover.
        const heavy = polymers.find((c) => inRange(len(c), PMHC.heavyChain));
        const b2m = polymers.find((c) => c !== heavy && inRange(len(c), PMHC.b2m) && similarity(seqOf(c), B2M_KMERS) > 0.3);
        const peptide = polymers.find((c) => inRange(len(c), PMHC.peptide));
        if (heavy && peptide) {
            roles.set(heavy.authAsymId, 'mhc');
            if (b2m) roles.set(b2m.authAsymId, 'b2m');
            roles.set(peptide.authAsymId, 'peptide');
            for (const c of polymers) if (!roles.has(c.authAsymId)) roles.set(c.authAsymId, 'binder');
        } else {
            const sorted = [...polymers].sort((a, b) => len(a) - len(b));
            roles.set(sorted[0]!.authAsymId, 'binder');
            for (const c of sorted.slice(1)) roles.set(c.authAsymId, 'target');
        }
    }

    return chains.map((c) => roles.get(c.authAsymId) ?? (c.isPolymer ? 'unassigned' : 'ligand'));
}

/**
 * AlphaFold/ColabFold write pLDDT into the B-factor column with the same value on
 * every atom of a residue; refined crystal B-factors vary atom to atom. So: all
 * values within 0–100 (or 0–1), not all zero (RFdiffusion backbones), and constant
 * within residues. Also returns the B-factor range for the ramp controls.
 */
function bfactorStats(structure: Structure): { plddt: boolean; range: [number, number]; atoms: number; hydrogens: number } {
    const loc = StructureElement.Location.create(structure);
    let min = Infinity;
    let max = -Infinity;
    let atoms = 0;
    let hydrogens = 0;
    let nonZero = 0;
    let residuesSeen = 0;
    let residuesVarying = 0;

    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit)) continue;
        loc.unit = unit;
        const { elements } = unit;
        const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
        atoms += elements.length;
        let lastResidue = -1;
        let residueB = 0;
        let varies = false;
        for (let i = 0; i < elements.length; i++) {
            const e = elements[i]!;
            loc.element = e;
            const b = P.atom.B_iso_or_equiv(loc);
            const symbol = P.atom.type_symbol(loc);
            if (symbol === 'H' || symbol === 'D') hydrogens++;
            if (b < min) min = b;
            if (b > max) max = b;
            if (b !== 0) nonZero++;
            const r = residueOf[e]!;
            if (r !== lastResidue) {
                if (lastResidue >= 0) {
                    residuesSeen++;
                    if (varies) residuesVarying++;
                }
                lastResidue = r;
                residueB = b;
                varies = false;
            } else if (Math.abs(b - residueB) > 1e-3) {
                varies = true;
            }
        }
        if (lastResidue >= 0) {
            residuesSeen++;
            if (varies) residuesVarying++;
        }
    }
    if (!Number.isFinite(min)) return { plddt: false, range: [0, 100], atoms, hydrogens };
    const inScale = min >= 0 && max <= 100;
    const constantPerResidue = residuesSeen > 0 && residuesVarying / residuesSeen < 0.02;
    return { plddt: nonZero > 0 && inScale && constantPerResidue, range: [min, max], atoms, hydrogens };
}

export interface DescribeOptions {
    name: string;
    source: StructureInfo['source'];
    path: string | null;
    format: StructureFormat;
    modelCount: number;
}

export function describeStructure(id: StructureId, structure: Structure, options: DescribeOptions): StructureInfo {
    let chains: ChainInfo[] = [];
    let stats = { plddt: false, range: [0, 100] as [number, number], atoms: 0, hydrogens: 0 };
    try {
        const raw = collectChains(structure);
        const roles = assignRoles(raw);
        chains = raw.map((c, i) => ({
            authAsymId: c.authAsymId,
            labelAsymId: c.labelAsymId,
            residueCount: c.residues.length,
            isPolymer: c.isPolymer,
            role: roles[i] ?? 'unassigned',
            alias: '',
            residues: c.residues,
        }));
        stats = bfactorStats(structure);
    } catch (e) {
        // Degrade to "loaded but undescribed": the structure is still viewable.
        console.error('[engine] Falha ao ler a hierarquia atômica (mol-model/structure).', e);
    }

    return {
        id,
        name: options.name,
        alias: '',
        source: options.source,
        path: options.path,
        format: options.format,
        chains,
        residueCount: chains.reduce((s, c) => s + c.residueCount, 0),
        atomCount: stats.atoms,
        hydrogenCount: stats.hydrogens,
        modelCount: options.modelCount,
        modelIndex: 0,
        looksLikePlddt: stats.plddt,
        bfactorRange: stats.range,
        visible: true,
    };
}

export const CHAIN_ROLE_LABELS: Record<ChainRole, string> = {
    binder: 'Binder',
    target: 'Alvo',
    mhc: 'MHC',
    b2m: 'β2m',
    peptide: 'Peptídeo',
    ligand: 'Ligante',
    unassigned: '—',
};
