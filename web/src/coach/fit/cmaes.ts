// (μ/μ_w, λ)-CMA-ES (Hansen 2016, "The CMA Evolution Strategy: A Tutorial") in the unit box
// [0,1]^d with an ask/tell interface (the caller evaluates a whole generation in parallel).
// Candidates outside the box are evaluated at their projection plus a quadratic penalty.

/** Symmetric eigendecomposition (cyclic Jacobi): A = V diag(w) Vᵀ. */
export function eigSym(A: Float64Array[], maxSweeps = 50): { w: Float64Array; V: Float64Array[] } {
  const n = A.length;
  const a = A.map((r) => Float64Array.from(r));
  const V = Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n);
    r[i] = 1;
    return r;
  });
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { w: Float64Array.from(a.map((r, i) => r[i])), V };
}

/** Deterministic PRNG (mulberry32) with Gaussian draws. */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0, v = 0;
    while (u <= 1e-12) u = this.next();
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

export interface CmaOptions {
  /** initial mean (unit box) */
  mean: Float64Array;
  /** initial step size */
  sigma: number;
  /** initial covariance (unit box; default identity) — e.g. from a Gauss–Newton Hessian */
  cov?: Float64Array[];
  lambda?: number;
  seed?: number;
}

export class CmaEs {
  readonly d: number;
  readonly lambda: number;
  readonly mu: number;
  private weights: Float64Array;
  private mueff: number;
  private cc: number;
  private cs: number;
  private c1: number;
  private cmu: number;
  private damps: number;
  private chiN: number;
  mean: Float64Array;
  sigma: number;
  C: Float64Array[];
  private pc: Float64Array;
  private ps: Float64Array;
  private B: Float64Array[];
  private D: Float64Array;
  private rng: Rng;
  private gen = 0;
  private lastZ: Float64Array[] = [];

  constructor(o: CmaOptions) {
    const d = (this.d = o.mean.length);
    this.lambda = o.lambda ?? 4 + Math.floor(3 * Math.log(d));
    this.mu = Math.floor(this.lambda / 2);
    const w = new Float64Array(this.mu);
    for (let i = 0; i < this.mu; i++) w[i] = Math.log((this.lambda + 1) / 2) - Math.log(i + 1);
    const sw = w.reduce((s, x) => s + x, 0);
    for (let i = 0; i < this.mu; i++) w[i] /= sw;
    this.weights = w;
    this.mueff = 1 / w.reduce((s, x) => s + x * x, 0);
    this.cc = (4 + this.mueff / d) / (d + 4 + (2 * this.mueff) / d);
    this.cs = (this.mueff + 2) / (d + this.mueff + 5);
    this.c1 = 2 / ((d + 1.3) ** 2 + this.mueff);
    this.cmu = Math.min(1 - this.c1, (2 * (this.mueff - 2 + 1 / this.mueff)) / ((d + 2) ** 2 + this.mueff));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (d + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(d) * (1 - 1 / (4 * d) + 1 / (21 * d * d));
    this.mean = Float64Array.from(o.mean);
    this.sigma = o.sigma;
    const covOk = !!o.cov && o.cov.every((r) => r.every(Number.isFinite));
    this.C = covOk ? o.cov!.map((r) => Float64Array.from(r)) : Array.from({ length: d }, (_, i) => Float64Array.from({ length: d }, (_, j) => (i === j ? 1 : 0)));
    this.pc = new Float64Array(d);
    this.ps = new Float64Array(d);
    this.rng = new Rng(o.seed ?? 1);
    const e = eigSym(this.C);
    this.B = e.V;
    this.D = e.w.map((x) => Math.sqrt(Math.max(x, 1e-20)));
  }

  /** λ candidates (unit box, unprojected). */
  ask(): Float64Array[] {
    const d = this.d;
    this.lastZ = [];
    const xs: Float64Array[] = [];
    for (let k = 0; k < this.lambda; k++) {
      const z = Float64Array.from({ length: d }, () => this.rng.gauss());
      this.lastZ.push(z);
      const x = new Float64Array(d);
      for (let i = 0; i < d; i++) {
        let s = 0;
        for (let j = 0; j < d; j++) s += this.B[i][j] * this.D[j] * z[j];
        x[i] = this.mean[i] + this.sigma * s;
      }
      xs.push(x);
    }
    return xs;
  }

  /** Update with the fitness (lower is better) of the candidates from the last ask(). */
  tell(xs: Float64Array[], f: number[]): void {
    const d = this.d;
    const order = f.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const old = this.mean;
    const mean = new Float64Array(d);
    for (let k = 0; k < this.mu; k++) {
      const x = xs[order[k]];
      for (let i = 0; i < d; i++) mean[i] += this.weights[k] * x[i];
    }
    this.mean = mean;
    const y = Float64Array.from({ length: d }, (_, i) => (mean[i] - old[i]) / this.sigma);
    // C^{-1/2} y = B D^{-1} Bᵀ y
    const bty = Float64Array.from({ length: d }, (_, j) => {
      let s = 0;
      for (let i = 0; i < d; i++) s += this.B[i][j] * y[i];
      return s / this.D[j];
    });
    const cinv = Float64Array.from({ length: d }, (_, i) => {
      let s = 0;
      for (let j = 0; j < d; j++) s += this.B[i][j] * bty[j];
      return s;
    });
    const csn = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
    for (let i = 0; i < d; i++) this.ps[i] = (1 - this.cs) * this.ps[i] + csn * cinv[i];
    this.gen++;
    const psn = Math.hypot(...this.ps);
    const hsig = psn / Math.sqrt(1 - (1 - this.cs) ** (2 * this.gen)) / this.chiN < 1.4 + 2 / (d + 1) ? 1 : 0;
    const ccn = Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
    for (let i = 0; i < d; i++) this.pc[i] = (1 - this.cc) * this.pc[i] + hsig * ccn * y[i];
    const ys = order.slice(0, this.mu).map((k) => Float64Array.from({ length: d }, (_, i) => (xs[k][i] - old[i]) / this.sigma));
    const c1a = this.c1 * (1 - (1 - hsig * hsig) * this.cc * (2 - this.cc));
    for (let i = 0; i < d; i++) {
      for (let j = 0; j <= i; j++) {
        let rmu = 0;
        for (let k = 0; k < this.mu; k++) rmu += this.weights[k] * ys[k][i] * ys[k][j];
        const v = (1 - c1a - this.cmu) * this.C[i][j] + this.c1 * this.pc[i] * this.pc[j] + this.cmu * rmu;
        this.C[i][j] = v;
        this.C[j][i] = v;
      }
    }
    this.sigma *= Math.exp((this.cs / this.damps) * (psn / this.chiN - 1));
    this.sigma = Math.min(this.sigma, 1);
    const e = eigSym(this.C);
    this.B = e.V;
    this.D = e.w.map((x) => Math.sqrt(Math.max(x, 1e-20)));
  }

  /** Largest standard deviation of the search distribution (unit box). */
  get spread(): number {
    return this.sigma * Math.max(...this.D);
  }
}
