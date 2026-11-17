// Small dense linear algebra for the mate solver: symmetric systems by Cholesky, symmetric eigenvalues by Jacobi,
// and the rank of a row set by Gram-Schmidt. Matrices are row-major Float64Arrays.

/** Solves A x = b for a symmetric positive definite A (n x n), or returns null when A is not. */
export function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i * n + j];
            for (let k = 0; k < j; k++) {
                s -= L[i * n + k] * L[j * n + k];
            }
            if (i === j) {
                if (!(s > 0)) {
                    return null;
                }
                L[i * n + i] = Math.sqrt(s);
            } else {
                L[i * n + j] = s / L[j * n + j];
            }
        }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) {
            s -= L[i * n + k] * y[k];
        }
        y[i] = s / L[i * n + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++) {
            s -= L[k * n + i] * x[k];
        }
        x[i] = s / L[i * n + i];
    }
    return x;
}

/** Eigenvalues and eigenvectors (columns of `vectors`) of a symmetric n x n matrix, by cyclic Jacobi rotations. */
export function symmetricEigen(M: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
    const a = Float64Array.from(M);
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        v[i * n + i] = 1;
    }
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0;
        let diag = 0;
        for (let i = 0; i < n; i++) {
            diag += a[i * n + i] * a[i * n + i];
            for (let j = i + 1; j < n; j++) {
                off += a[i * n + j] * a[i * n + j];
            }
        }
        if (off <= 1e-30 * Math.max(diag, 1e-300)) {
            break;
        }
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p * n + q];
                if (Math.abs(apq) < 1e-300) {
                    continue;
                }
                const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = a[k * n + p];
                    const akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p * n + k];
                    const aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k * n + p];
                    const vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        values[i] = a[i * n + i];
    }
    return { values, vectors: v };
}

/**
 * Rows added one at a time to an orthonormal basis: `add` says whether a row brings a new direction (its part off the
 * basis is longer than `tolerance` times its length, or than `floor`).
 */
export class RowBasis {
    private basis: Float64Array[] = [];

    constructor(private readonly tolerance = 1e-7, private readonly floor = 1e-9) {}

    get rank(): number {
        return this.basis.length;
    }

    /** Whether the row is independent of those taken so far; when it is, it joins them (unless `probe`). */
    add(row: ArrayLike<number>, probe = false): boolean {
        const w = Float64Array.from(row);
        let norm0 = 0;
        for (let i = 0; i < w.length; i++) {
            norm0 += w[i] * w[i];
        }
        norm0 = Math.sqrt(norm0);
        if (norm0 <= this.floor) {
            return false;
        }
        // Twice, for round-off.
        for (let pass = 0; pass < 2; pass++) {
            for (const b of this.basis) {
                let d = 0;
                for (let i = 0; i < w.length; i++) {
                    d += w[i] * b[i];
                }
                for (let i = 0; i < w.length; i++) {
                    w[i] -= d * b[i];
                }
            }
        }
        let norm = 0;
        for (let i = 0; i < w.length; i++) {
            norm += w[i] * w[i];
        }
        norm = Math.sqrt(norm);
        if (norm <= this.tolerance * norm0 || norm <= this.floor) {
            return false;
        }
        if (!probe) {
            for (let i = 0; i < w.length; i++) {
                w[i] /= norm;
            }
            this.basis.push(w);
        }
        return true;
    }
}
