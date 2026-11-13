// Runs `script` shapes: replicad code written by Jarvis, in a node:vm context that only sees `r` (replicad),
// `params`, `Math` and `console`. Host objects reach the script through a membrane of proxies that hide
// `constructor` and prototypes, so the script cannot climb to the host's Function and from there to `process`.

import vm from 'node:vm';
import * as replicad from 'replicad';
import type { Shape3D } from 'replicad';

export const SCRIPT_TIMEOUT_MS = 30_000;

/** Names exported by replicad, for telling the model what `r` offers. */
export function replicadApiNames(): string[] {
    return Object.keys(replicad).sort();
}

const BLOCKED = new Set<PropertyKey>(['constructor', '__proto__', '__defineGetter__', '__defineSetter__',
    '__lookupGetter__', '__lookupSetter__']);

class Membrane {
    private readonly proxies = new WeakMap<object, object>();
    private readonly targets = new WeakMap<object, object>();
    private readonly callbacks = new WeakMap<object, object>();

    constructor(private readonly sandboxObject: object) {}

    /** Host value to something the script may hold. */
    wrap(value: unknown): unknown {
        if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
            return value;
        }
        if (this.targets.has(value)) {
            return value;
        }
        const cached = this.proxies.get(value);
        if (cached) {
            return cached;
        }
        const real = value as object;
        // Shadow target, so proxy invariants never force us to hand out the real (host-realm) values.
        const shadow = typeof value === 'function' ? function () {} : {};
        const self = this;
        const guard = <T>(run: () => T): T => {
            try {
                return run();
            } catch (e) {
                throw self.wrap(e);
            }
        };
        const proxy = new Proxy(shadow, {
            get: (_t, key) => {
                if (key === 'constructor') {
                    // Enough for `x.constructor.name`, without handing out the host's constructor.
                    const name = guard(() => (real as { constructor?: { name?: string } }).constructor?.name);
                    return self.wrap({ name });
                }
                return BLOCKED.has(key) ? undefined : guard(() => self.wrap(Reflect.get(real, key, real)));
            },
            set: (_t, key, v) => !BLOCKED.has(key) && guard(() => Reflect.set(real, key, self.unwrap(v), real)),
            has: (_t, key) => Reflect.has(real, key),
            ownKeys: () => {
                const keys = Reflect.ownKeys(real);
                return typeof shadow === 'function' && !keys.includes('prototype') ? [...keys, 'prototype'] : keys;
            },
            getOwnPropertyDescriptor: (_t, key) => {
                const own = Reflect.getOwnPropertyDescriptor(shadow, key);
                if (own && !own.configurable) {
                    return { ...own, value: self.wrap(Reflect.get(real, key, real)) };
                }
                const desc = Reflect.getOwnPropertyDescriptor(real, key);
                if (!desc) {
                    return undefined;
                }
                return { configurable: true, enumerable: desc.enumerable, writable: false,
                    value: guard(() => self.wrap(Reflect.get(real, key, real))) };
            },
            defineProperty: () => false,
            deleteProperty: () => false,
            getPrototypeOf: () => null,
            setPrototypeOf: () => false,
            apply: (_t, thisArg, args) => guard(() => self.wrap(Reflect.apply(real as (...a: unknown[]) => unknown,
                self.unwrap(thisArg), args.map((a) => self.unwrap(a))))),
            construct: (_t, args) => guard(() => self.wrap(Reflect.construct(real as new (...a: unknown[]) => object,
                args.map((a) => self.unwrap(a))))) as object,
        });
        this.proxies.set(real, proxy);
        this.targets.set(proxy, real);
        return proxy;
    }

    /** Script value to something the host (replicad) can use. */
    unwrap(value: unknown): unknown {
        if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
            return value;
        }
        const real = this.targets.get(value);
        if (real) {
            return real;
        }
        if (typeof value === 'function') {
            let host = this.callbacks.get(value);
            if (!host) {
                const fn = value as (...a: unknown[]) => unknown;
                host = (...args: unknown[]) => this.unwrap(fn(...args.map((a) => this.wrap(a))));
                this.callbacks.set(value, host);
            }
            return host;
        }
        if (Array.isArray(value)) {
            return Array.from(value, (v) => this.unwrap(v));
        }
        const proto = Object.getPrototypeOf(value);
        if (proto === this.sandboxObject || proto === null) {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = this.unwrap(v);
            }
            return out;
        }
        return value;
    }
}

function typeName(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (typeof value !== 'object') {
        return typeof value;
    }
    return (value as object).constructor?.name ?? 'object';
}

function isSolidShape(value: unknown): value is Shape3D {
    return value instanceof replicad.Solid || value instanceof replicad.Compound || value instanceof replicad.CompSolid;
}

/**
 * Runs script code (the body of `(r, params) => Shape3D`) and returns its solid as the script made it, in
 * replicad's own Z-up frame. Errors are thrown as `script: <reason>`.
 */
export function runScript(code: string, params: Record<string, number>, timeout = SCRIPT_TIMEOUT_MS): Shape3D {
    const context = vm.createContext(Object.create(null), {
        name: 'jarvis-script',
        codeGeneration: { strings: false, wasm: false },
    });
    const sandboxObject = vm.runInContext('Object.prototype', context) as object;
    const membrane = new Membrane(sandboxObject);
    const log = (level: 'log' | 'warn' | 'error') => (...args: unknown[]) => console[level]('[script]', ...args);
    context.r = membrane.wrap({ ...replicad });
    context.console = membrane.wrap({ log: log('log'), info: log('log'), warn: log('warn'), error: log('error') });
    context.__params = JSON.stringify(params ?? {});
    let result: unknown;
    try {
        result = vm.runInContext(
            `(function () { const params = JSON.parse(__params); return (function (r, params) {\n${code}\n})(r, params); })()`,
            context, { timeout, filename: 'script.js' });
    } catch (e) {
        const error = membrane.unwrap(e);
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
            throw new Error(`script: timed out after ${Math.round(timeout / 1000)} s`);
        }
        throw new Error(`script: ${scriptError(error)}`);
    }
    const shape = membrane.unwrap(result);
    if (!isSolidShape(shape)) {
        throw new Error(`script: must return a solid, got ${typeName(shape)}`);
    }
    // A boolean often wraps its one solid in a compound: unwrap it so features apply as usual.
    const solids = shape.solids;
    if (solids.length === 0) {
        throw new Error('script: result is empty (the boolean found no overlap?)');
    }
    return solids.length === 1 && !(shape instanceof replicad.Solid) ? solids[0] : shape;
}

function scriptError(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message) {
        return error.message;
    }
    try {
        const oc = replicad.getOC() as unknown as { getExceptionMessage(e: unknown): [string, string] };
        const [type, message] = oc.getExceptionMessage(error);
        return `OpenCascade ${type}${message ? `: ${message}` : ''}`;
    } catch {
        return String(error);
    }
}
