// A small expression language for equation driven curves, read without eval: numbers, + - * / ^, parentheses, the
// variables of the curve (x, or t) and the functions of the SolidWorks equations (sin, cos, tan, sec, cosec, cotan,
// arcsin, arccos, atn, arcsec, arccosec, arccotan, abs, exp, log (natural), sqr (square root), int, sgn) plus common
// spellings (sqrt, ln, asin, acos, atan, arctan, log10) and the constant pi. Angles are radians.

type Fn = (a: number) => number;

const FUNCTIONS: Record<string, Fn> = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    sec: (a) => 1 / Math.cos(a), cosec: (a) => 1 / Math.sin(a), cotan: (a) => 1 / Math.tan(a),
    arcsin: Math.asin, arccos: Math.acos, atn: Math.atan, arcsec: (a) => Math.acos(1 / a), arccosec: (a) => Math.asin(1 / a),
    arccotan: (a) => Math.PI / 2 - Math.atan(a),
    abs: Math.abs, exp: Math.exp, log: Math.log, sqr: Math.sqrt, int: Math.trunc, sgn: Math.sign,
    sqrt: Math.sqrt, ln: Math.log, asin: Math.asin, acos: Math.acos, atan: Math.atan, arctan: Math.atan, log10: Math.log10,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI };

export type Compiled = (vars: Record<string, number>) => number;

type Node = (v: Record<string, number>) => number;

/** The expression as a function of its variables, or an error saying where it went wrong. */
export function compileExpression(source: string, variables: readonly string[]): { f: Compiled } | { error: string } {
    const text = source.replace(/\s+/g, ' ').trim();
    let i = 0;
    const fail = (what: string): never => {
        throw new Error(i < text.length ? `${what} at “${text.slice(i, i + 8)}”` : `${what} at the end`);
    };
    const space = () => {
        while (text[i] === ' ') {
            i += 1;
        }
    };
    const peek = () => {
        space();
        return text[i];
    };
    const atom = (): Node => {
        const c = peek();
        if (c === '(') {
            i += 1;
            const inner = expr();
            if (peek() !== ')') {
                fail('A closing bracket is missing');
            }
            i += 1;
            return inner;
        }
        const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(i));
        if (num) {
            i += num[0].length;
            const value = Number(num[0]);
            return () => value;
        }
        const name = /^[a-z_][a-z0-9_]*/i.exec(text.slice(i));
        if (name) {
            const word = name[0].toLowerCase();
            i += name[0].length;
            if (peek() === '(' && FUNCTIONS[word]) {
                i += 1;
                const arg = expr();
                if (peek() !== ')') {
                    fail('A closing bracket is missing');
                }
                i += 1;
                const fn = FUNCTIONS[word];
                return (v) => fn(arg(v));
            }
            if (variables.includes(word)) {
                return (v) => v[word];
            }
            if (word in CONSTANTS) {
                const value = CONSTANTS[word];
                return () => value;
            }
            i -= name[0].length;
            fail(FUNCTIONS[word] ? `${word} needs its argument in brackets` : `Unknown name “${name[0]}” (use ${variables.join(' or ')})`);
        }
        return fail(c === undefined ? 'Something is missing' : 'Unexpected text');
    };
    const unary = (): Node => {
        const c = peek();
        if (c === '-' || c === '+') {
            i += 1;
            const inner = unary();
            return c === '-' ? (v) => -inner(v) : inner;
        }
        return power();
    };
    const power = (): Node => {
        const base = atom();
        if (peek() === '^') {
            i += 1;
            // Right to left, and above the sign of what follows: 2^-1 is a half.
            const exponent = unary();
            return (v) => base(v) ** exponent(v);
        }
        return base;
    };
    const term = (): Node => {
        let left = unary();
        for (let c = peek(); c === '*' || c === '/'; c = peek()) {
            i += 1;
            const right = unary();
            const l = left;
            left = c === '*' ? (v) => l(v) * right(v) : (v) => l(v) / right(v);
        }
        return left;
    };
    const expr = (): Node => {
        let left = term();
        for (let c = peek(); c === '+' || c === '-'; c = peek()) {
            i += 1;
            const right = term();
            const l = left;
            left = c === '+' ? (v) => l(v) + right(v) : (v) => l(v) - right(v);
        }
        return left;
    };
    try {
        if (!text) {
            return { error: 'The equation is empty.' };
        }
        const f = expr();
        if (peek() !== undefined) {
            fail('Unexpected text');
        }
        return { f };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/** A constant expression (a range end such as "2*pi"), or null. */
export function constantValue(source: string): number | null {
    const r = compileExpression(source, []);
    if ('error' in r) {
        return null;
    }
    const v = r.f({});
    return Number.isFinite(v) ? v : null;
}
