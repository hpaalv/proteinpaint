/**
 * ChimeraX-style atom specifications, the subset designers type all day:
 *
 *   /A            chain A            /A,C        chains A and C
 *   :30-45        residues 30–45     :30,35,40-42
 *   :TYR,PHE      by residue name    @CA,CB      by atom name
 *   #2/B:10-20    structure 2 (1-based, scene order), chain B, residues 10–20
 *   /B:30-45@CA   combined
 *   sel  all  protein  ligand  water  helix  strand  backbone  sidechain
 *   a & b   a | b   ~a   ( … )
 *   X @<5         atoms within 5 Å of X (X included);  X :<5  whole residues
 *
 * parseSpec is pure (no Mol*); compileSpec turns the tree into MolScript.
 */

import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import type { Expression } from 'molstar/lib/mol-script/language/expression';
import { StructureSelectionQueries as Q } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { heteroExpression } from './style';

type ResidueItem = { kind: 'range'; from: number; to: number } | { kind: 'name'; name: string };

export type SpecNode =
    | { kind: 'atoms'; models: number[] | null; chains: string[] | null; residues: ResidueItem[] | null; atoms: string[] | null }
    | { kind: 'keyword'; name: Keyword }
    | { kind: 'and' | 'or'; a: SpecNode; b: SpecNode }
    | { kind: 'not'; a: SpecNode }
    | { kind: 'zone'; a: SpecNode; radius: number; wholeResidues: boolean };

const KEYWORDS = ['sel', 'all', 'protein', 'ligand', 'water', 'helix', 'strand', 'backbone', 'sidechain', 'nucleic'] as const;
type Keyword = (typeof KEYWORDS)[number];

export type ParseResult = { ok: true; node: SpecNode; usesSelection: boolean } | { ok: false; error: string };

class Parser {
    private i = 0;
    usesSelection = false;
    constructor(private readonly s: string) {}

    private ws() {
        while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
    }
    private peek(): string {
        this.ws();
        return this.s[this.i] ?? '';
    }
    private fail(msg: string): never {
        throw new Error(`${msg} (posição ${this.i + 1})`);
    }

    parse(): SpecNode {
        const node = this.or();
        if (this.peek() !== '') this.fail(`Símbolo inesperado "${this.s[this.i]}"`);
        return node;
    }

    private or(): SpecNode {
        let a = this.and();
        while (this.peek() === '|') {
            this.i++;
            a = { kind: 'or', a, b: this.and() };
        }
        return a;
    }

    private and(): SpecNode {
        let a = this.unary();
        while (this.peek() === '&') {
            this.i++;
            a = { kind: 'and', a, b: this.unary() };
        }
        return a;
    }

    private unary(): SpecNode {
        if (this.peek() === '~') {
            this.i++;
            return { kind: 'not', a: this.unary() };
        }
        return this.zone(this.primary());
    }

    /** Postfix zone operators: `@<r` (atoms) and `:<r` (whole residues). */
    private zone(a: SpecNode): SpecNode {
        for (;;) {
            this.ws();
            const two = this.s.slice(this.i, this.i + 2);
            if (two !== '@<' && two !== ':<') return a;
            this.i += 2;
            const r = this.number();
            a = { kind: 'zone', a, radius: r, wholeResidues: two === ':<' };
        }
    }

    private primary(): SpecNode {
        const c = this.peek();
        if (c === '(') {
            this.i++;
            const node = this.or();
            if (this.peek() !== ')') this.fail('Faltou ")"');
            this.i++;
            return node;
        }
        if (c === '#' || c === '/' || c === ':' || c === '@') return this.atomSpec();
        const word = this.word();
        if (!word) this.fail('Especificação vazia');
        const kw = word.toLowerCase() as Keyword;
        if ((KEYWORDS as readonly string[]).includes(kw)) {
            if (kw === 'sel') this.usesSelection = true;
            return { kind: 'keyword', name: kw };
        }
        this.fail(`Palavra desconhecida "${word}"`);
    }

    private atomSpec(): SpecNode {
        let models: number[] | null = null;
        let chains: string[] | null = null;
        let residues: ResidueItem[] | null = null;
        let atoms: string[] | null = null;
        this.ws();
        if (this.s[this.i] === '#') {
            this.i++;
            models = this.list().map((t) => {
                const n = Number(t);
                if (!Number.isInteger(n) || n < 1) this.fail(`Modelo inválido "${t}"`);
                return n;
            });
        }
        if (this.s[this.i] === '/') {
            this.i++;
            chains = this.list();
        }
        if (this.s[this.i] === ':' && this.s[this.i + 1] !== '<') {
            this.i++;
            residues = this.list().map((t) => this.residueItem(t));
        }
        if (this.s[this.i] === '@' && this.s[this.i + 1] !== '<') {
            this.i++;
            atoms = this.list().map((t) => t.toUpperCase());
        }
        if (!models && !chains && !residues && !atoms) this.fail('Especificação de átomos vazia');
        return { kind: 'atoms', models, chains, residues, atoms };
    }

    private residueItem(t: string): ResidueItem {
        const range = /^(-?\d+)(?:-(-?\d+))?$/.exec(t);
        if (range) {
            const from = Number(range[1]);
            const to = range[2] === undefined ? from : Number(range[2]);
            return { kind: 'range', from: Math.min(from, to), to: Math.max(from, to) };
        }
        if (/^[A-Za-z0-9]{1,4}$/.test(t)) return { kind: 'name', name: t.toUpperCase() };
        this.fail(`Resíduo inválido "${t}"`);
    }

    /** Comma-separated tokens; stops at whitespace or a spec delimiter. */
    private list(): string[] {
        const start = this.i;
        while (this.i < this.s.length && /[A-Za-z0-9_,\-'*]/.test(this.s[this.i]!)) this.i++;
        const raw = this.s.slice(start, this.i);
        const items = raw.split(',').filter(Boolean);
        if (items.length === 0) this.fail('Lista vazia');
        return items;
    }

    private word(): string {
        this.ws();
        const start = this.i;
        while (this.i < this.s.length && /[A-Za-z]/.test(this.s[this.i]!)) this.i++;
        return this.s.slice(start, this.i);
    }

    private number(): number {
        this.ws();
        const m = /^\d+(\.\d+)?/.exec(this.s.slice(this.i));
        if (!m) this.fail('Esperado um raio em Å');
        this.i += m[0].length;
        return Number(m[0]);
    }
}

export function parseSpec(text: string): ParseResult {
    const p = new Parser(text.trim());
    try {
        const node = p.parse();
        return { ok: true, node, usesSelection: p.usesSelection };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

// ---------------------------------------------------------------------------

const all = () => MS.struct.generator.all();
const none = () => MS.struct.generator.empty();

function keywordExpression(name: Keyword): Expression {
    switch (name) {
        case 'sel':
            return MS.internal.generator.current();
        case 'all':
            return all();
        case 'protein':
            return Q.protein.expression;
        case 'nucleic':
            return Q.nucleic.expression;
        case 'ligand':
            return heteroExpression();
        case 'water':
            return Q.water.expression;
        case 'helix':
            return Q.helix.expression;
        case 'strand':
            return Q.beta.expression;
        case 'backbone':
            return Q.backbone.expression;
        case 'sidechain':
            return Q.sidechain.expression;
    }
}

function atomsExpression(node: Extract<SpecNode, { kind: 'atoms' }>, structureIndex: number): Expression {
    if (node.models && !node.models.includes(structureIndex + 1)) return none();
    const tests: Record<string, Expression> = {};
    if (node.chains) tests['chain-test'] = MS.core.set.has([MS.set(...node.chains), MS.ammp('auth_asym_id')]);
    if (node.residues) {
        const names = node.residues.filter((r) => r.kind === 'name').map((r) => (r as { name: string }).name);
        const ranges = node.residues.filter((r) => r.kind === 'range') as { from: number; to: number }[];
        const parts: Expression[] = ranges.map((r) => MS.core.rel.inRange([MS.ammp('auth_seq_id'), r.from, r.to]));
        if (names.length) parts.push(MS.core.set.has([MS.set(...names), MS.ammp('label_comp_id')]));
        tests['residue-test'] = parts.length === 1 ? parts[0]! : MS.core.logic.or(parts);
    }
    if (node.atoms) tests['atom-test'] = MS.core.set.has([MS.set(...node.atoms), MS.ammp('label_atom_id')]);
    return MS.struct.generator.atomGroups(tests);
}

/** Compiles for one structure — `#N` is resolved against its scene position. */
export function compileSpec(node: SpecNode, structureIndex: number): Expression {
    switch (node.kind) {
        case 'atoms':
            return atomsExpression(node, structureIndex);
        case 'keyword':
            return keywordExpression(node.name);
        case 'and':
            return MS.struct.modifier.intersectBy({ 0: compileSpec(node.a, structureIndex), by: compileSpec(node.b, structureIndex) });
        case 'or':
            return MS.struct.combinator.merge([compileSpec(node.a, structureIndex), compileSpec(node.b, structureIndex)]);
        case 'not':
            return MS.struct.modifier.exceptBy({ 0: all(), by: compileSpec(node.a, structureIndex) });
        case 'zone':
            return MS.struct.modifier.includeSurroundings({
                0: compileSpec(node.a, structureIndex),
                radius: node.radius,
                'as-whole-residues': node.wholeResidues,
            });
    }
}
