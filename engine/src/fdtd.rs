//! 1-D Webster horn equation on a staggered grid (pressure p at nodes,
//! volume velocity U at half nodes), with visco-thermal boundary-layer losses.
//!
//!   (ρ/S) ∂U/∂t = −∂p/∂x − (k_vt /(S r)) · √s · U          (series, per unit length)
//!   (V/ρc²) ∂p/∂t = −ΔU                                     (per cell of volume V)
//!
//! Discretisation (Bilbao, "Numerical Sound Synthesis" ch. 9):
//!   U_{i+½}^{n+½} = U^{n−½} − (Δt S_{i+½}/(ρΔx)) (p_{i+1}−p_i) − loss
//!   p_i^{n+1}     = p_i^n − (ρc²Δt/V_i)(U_{i+½} − U_{i−½} + Σ U_branch)
//! with V_i = Δx (S_{i−½}+S_{i+½})/2, which is stable for λ = cΔt/Δx ≤ 1 for any
//! area profile. The √s boundary-layer operator is approximated by a sum of three
//! positive-real first-order high-pass sections a_k s/(s+b_k) (each passive),
//! fitted to √(jω) over 80 Hz–5 kHz (±10 %). Each section needs one state per
//! half node; the resistive part is treated trapezoidally (unconditionally
//! dissipative), the section states with an exact one-pole update.

use crate::air::Air;

/// Minimal 4 × f32 SIMD layer for the fused bore kernel: NEON on aarch64,
/// simd128 on wasm32, plain arrays elsewhere. `mla(a, b, c)` = a + b·c is a
/// fused multiply-add only where the ISA has one (aarch64; wasm simd128 has no
/// FMA outside relaxed-simd), otherwise mul + add.
#[allow(unused_unsafe, dead_code)]
pub(crate) mod f4 {
    #[cfg(target_arch = "aarch64")]
    mod imp {
        use core::arch::aarch64::*;
        pub type V = float32x4_t;
        #[inline(always)]
        pub unsafe fn ld(p: *const f32) -> V {
            vld1q_f32(p)
        }
        #[inline(always)]
        pub unsafe fn st(p: *mut f32, v: V) {
            vst1q_f32(p, v)
        }
        #[inline(always)]
        pub fn splat(x: f32) -> V {
            unsafe { vdupq_n_f32(x) }
        }
        #[inline(always)]
        pub fn add(a: V, b: V) -> V {
            unsafe { vaddq_f32(a, b) }
        }
        #[inline(always)]
        pub fn sub(a: V, b: V) -> V {
            unsafe { vsubq_f32(a, b) }
        }
        #[inline(always)]
        pub fn mul(a: V, b: V) -> V {
            unsafe { vmulq_f32(a, b) }
        }
        /// a + b·c (fused)
        #[inline(always)]
        pub fn mla(a: V, b: V, c: V) -> V {
            unsafe { vfmaq_f32(a, b, c) }
        }
        /// a − b·c (fused)
        #[inline(always)]
        pub fn mls(a: V, b: V, c: V) -> V {
            unsafe { vfmsq_f32(a, b, c) }
        }
        /// [a₃, b₀, b₁, b₂]
        #[inline(always)]
        pub fn shift_in(a: V, b: V) -> V {
            unsafe { vextq_f32::<3>(a, b) }
        }
    }

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    mod imp {
        use core::arch::wasm32::*;
        pub type V = v128;
        #[inline(always)]
        pub unsafe fn ld(p: *const f32) -> V {
            v128_load(p as *const v128)
        }
        #[inline(always)]
        pub unsafe fn st(p: *mut f32, v: V) {
            v128_store(p as *mut v128, v)
        }
        #[inline(always)]
        pub fn splat(x: f32) -> V {
            f32x4_splat(x)
        }
        #[inline(always)]
        pub fn add(a: V, b: V) -> V {
            f32x4_add(a, b)
        }
        #[inline(always)]
        pub fn sub(a: V, b: V) -> V {
            f32x4_sub(a, b)
        }
        #[inline(always)]
        pub fn mul(a: V, b: V) -> V {
            f32x4_mul(a, b)
        }
        #[cfg(not(target_feature = "relaxed-simd"))]
        #[inline(always)]
        pub fn mla(a: V, b: V, c: V) -> V {
            f32x4_add(a, f32x4_mul(b, c))
        }
        #[cfg(not(target_feature = "relaxed-simd"))]
        #[inline(always)]
        pub fn mls(a: V, b: V, c: V) -> V {
            f32x4_sub(a, f32x4_mul(b, c))
        }
        // optional build with relaxed SIMD (fused or unfused at the engine's
        // discretion — both within the regression tolerance)
        #[cfg(target_feature = "relaxed-simd")]
        #[inline(always)]
        pub fn mla(a: V, b: V, c: V) -> V {
            f32x4_relaxed_madd(b, c, a)
        }
        #[cfg(target_feature = "relaxed-simd")]
        #[inline(always)]
        pub fn mls(a: V, b: V, c: V) -> V {
            f32x4_relaxed_nmadd(b, c, a)
        }
        #[inline(always)]
        pub fn shift_in(a: V, b: V) -> V {
            i32x4_shuffle::<3, 4, 5, 6>(a, b)
        }
    }

    #[cfg(not(any(target_arch = "aarch64", all(target_arch = "wasm32", target_feature = "simd128"))))]
    mod imp {
        pub type V = [f32; 4];
        #[inline(always)]
        pub unsafe fn ld(p: *const f32) -> V {
            [*p, *p.add(1), *p.add(2), *p.add(3)]
        }
        #[inline(always)]
        pub unsafe fn st(p: *mut f32, v: V) {
            for (k, x) in v.iter().enumerate() {
                *p.add(k) = *x;
            }
        }
        #[inline(always)]
        pub fn splat(x: f32) -> V {
            [x; 4]
        }
        #[inline(always)]
        fn map2(a: V, b: V, f: impl Fn(f32, f32) -> f32) -> V {
            [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
        }
        #[inline(always)]
        pub fn add(a: V, b: V) -> V {
            map2(a, b, |x, y| x + y)
        }
        #[inline(always)]
        pub fn sub(a: V, b: V) -> V {
            map2(a, b, |x, y| x - y)
        }
        #[inline(always)]
        pub fn mul(a: V, b: V) -> V {
            map2(a, b, |x, y| x * y)
        }
        #[inline(always)]
        pub fn mla(a: V, b: V, c: V) -> V {
            add(a, mul(b, c))
        }
        #[inline(always)]
        pub fn mls(a: V, b: V, c: V) -> V {
            sub(a, mul(b, c))
        }
        #[inline(always)]
        pub fn shift_in(a: V, b: V) -> V {
            [a[3], b[0], b[1], b[2]]
        }
    }

    pub use imp::*;
}

pub const NPOLES: usize = 3;
/// √s ≈ Σ a_k s/(s+b_k)  (b in rad/s)
pub const LOSS_A: [f64; NPOLES] = [20.948067, 45.777930, 282.595182];
pub const LOSS_B: [f64; NPOLES] = [294.578962, 3973.918823, 53609.201726];

/// Lane width of the interleaved layout.
const L: usize = 4;

/// Per-4-node block: loss states and coefficients of half nodes 4c..4c+3 and the
/// lossless pressure gain of nodes 4c..4c+3, interleaved so the fused kernel
/// streams ONE array (paired 2×16-byte loads/stores, one pointer increment)
/// instead of seven.
#[repr(C, align(16))]
#[derive(Clone, Copy, Default)]
struct Blk {
    /// loss-section states ŵ_k (low-passed U, scaled by 1/e_k)
    w0: [f32; L],
    w1: [f32; L],
    w2: [f32; L],
    /// U update coefficients (0 for padding half nodes ≥ n−1 → U stays 0)
    c1: [f32; L],
    c2: [f32; L],
    c3: [f32; L],
    /// pressure gain of a lossless node: ρc²Δt/V for interior nodes 1..n−2,
    /// 0 for the end nodes and padding (their pressure is left untouched)
    kq: [f32; L],
}

/// Per-4-node thermal block (only blocks overlapping nodes 1..thermal_nodes):
/// p ← q1·p − q2·ΔU + q3·Σt. Non-thermal lanes carry (1, kq, 0), which is
/// bit-identical to the lossless update (1·p exact, +0·Σt exact).
#[repr(C, align(16))]
#[derive(Clone, Copy, Default)]
struct TBlk {
    t0: [f32; L],
    t1: [f32; L],
    t2: [f32; L],
    q1: [f32; L],
    q2: [f32; L],
    q3: [f32; L],
}

#[derive(Clone, Default)]
pub struct Tube {
    /// number of pressure nodes
    pub n: usize,
    pub dx: f64,
    pub dt: f64,
    /// pressure at nodes (Pa); len ≥ n (zero-gain padding after n−1)
    pub p: Vec<f32>,
    /// volume velocity at half nodes (m³/s); entries ≥ n−1 are padding (always 0)
    pub u: Vec<f32>,
    /// ρc²Δt/V_i at nodes (len n)
    pub kp: Vec<f32>,
    /// loss-section recursion (d = 1−β, e = β·a). The states are stored scaled
    /// by 1/e_k — ŵ_k ← d_k·ŵ_k + U, Σ_k w_k = Σ_k e_k·ŵ_k — which is the same
    /// filter with one multiply fewer per state.
    dk: [f32; NPOLES],
    ek: [f32; NPOLES],
    /// areas at half nodes (m²), len n−1 (kept for telemetry / boundary use)
    pub s_half: Vec<f64>,
    /// node volumes without branch additions
    pub vol: Vec<f64>,
    /// nodes [1, thermal_nodes) carry the thermal boundary-layer loss as an
    /// explicit shunt term on the pressure update (E2b); elsewhere it is lumped
    /// into the series term (cheaper; accurate where the bore is wide)
    pub thermal_nodes: usize,
    /// additive inertance length per half node (m; tone-hole series
    /// corrections t_a, usually negative): L = ρ(Δx + dl)/S
    pub dl_half: Vec<f64>,
    /// override of the √s fit (a_k, b_k) — loss-model studies only (a_k = 0
    /// disables a section); None = LOSS_A / LOSS_B
    pub loss_ab: Option<([f64; NPOLES], [f64; NPOLES])>,
    blk: Vec<Blk>,
    tblk: Vec<TBlk>,
    /// number of blocks in use (cover half nodes 0..n−2 and nodes 0..n−2)
    nb: usize,
    /// number of leading blocks with thermal lanes
    ntb: usize,
}

#[inline(always)]
fn lane(i: usize) -> (usize, usize) {
    (i / L, i % L)
}

impl Tube {
    /// Allocate a tube with room for `cap` nodes.
    pub fn with_capacity(cap: usize) -> Tube {
        let mut t = Tube::default();
        let c = cap.max(2);
        let nb = (c + L - 1) / L + 1;
        t.p.reserve(L * nb + L);
        t.u.reserve(L * nb);
        t.kp.reserve(c);
        t.s_half.reserve(c);
        t.vol.reserve(c);
        t.dl_half.reserve(c);
        t.blk.reserve(nb);
        t.tblk.reserve(nb);
        t
    }

    /// Resize to `n` nodes (state zeroed). Does not allocate if within capacity.
    pub fn resize(&mut self, n: usize) {
        let n = n.max(2);
        self.n = n;
        self.nb = (n - 1 + L - 1) / L;
        let nb = self.nb;
        self.p.clear();
        self.p.resize(L * nb + L, 0.0);
        self.u.clear();
        self.u.resize(L * nb, 0.0);
        self.kp.clear();
        self.kp.resize(n, 0.0);
        self.blk.clear();
        self.blk.resize(nb, Blk::default());
        self.tblk.clear();
        self.tblk.resize(nb, TBlk::default());
        self.ntb = 0;
        self.s_half.clear();
        self.s_half.resize(n - 1, 1e-4);
        self.vol.clear();
        self.vol.resize(n, 0.0);
        self.dl_half.clear();
        self.dl_half.resize(n - 1, 0.0);
        self.thermal_nodes = self.thermal_nodes.min(n - 1);
    }

    pub fn clear_state(&mut self) {
        self.p.iter_mut().for_each(|x| *x = 0.0);
        self.u.iter_mut().for_each(|x| *x = 0.0);
        for b in self.blk.iter_mut() {
            b.w0 = [0.0; L];
            b.w1 = [0.0; L];
            b.w2 = [0.0; L];
        }
        for b in self.tblk.iter_mut() {
            b.t0 = [0.0; L];
            b.t1 = [0.0; L];
            b.t2 = [0.0; L];
        }
    }

    /// Recompute all coefficients. `area_half(i)` gives S at x=(i+½)Δx.
    /// `extra_vol[i]` is added to node i's volume (closed side-branch volumes).
    /// `loss_mult` scales boundary-layer losses (0 = lossless, 1 = smooth rigid wall).
    pub fn set_coeffs(&mut self, dx: f64, dt: f64, air: &Air, loss_mult: f64, extra_vol: Option<&[f64]>) {
        let n = self.n;
        self.dx = dx;
        self.dt = dt;
        let rho = air.rho;
        let rc2 = rho * air.c * air.c;
        let kvt = air.k_vt();
        // purely viscous series factor (used where thermal is an explicit shunt)
        let kv = 2.0 * (rho * air.eta).sqrt();
        // thermal shunt factor: ℓ_t = kp · kt · S Δx / r
        let kt = 2.0 * (air.gamma - 1.0) / (rc2) * (air.eta / rho).sqrt() / air.nu;
        let nth = self.thermal_nodes.min(n - 1);
        let (la, lb) = self.loss_ab.unwrap_or((LOSS_A, LOSS_B));
        let asum: f64 = la.iter().sum();
        for k in 0..NPOLES {
            let beta = 1.0 - (-lb[k] * dt).exp();
            self.dk[k] = (1.0 - beta) as f32;
            self.ek[k] = (beta * la[k]) as f32;
        }
        // padding half nodes / nodes: zero coefficients (U, p stay put)
        for b in self.blk.iter_mut() {
            b.c1 = [0.0; L];
            b.c2 = [0.0; L];
            b.c3 = [0.0; L];
            b.kq = [0.0; L];
        }
        for i in 0..n - 1 {
            let s = self.s_half[i].max(1e-8);
            let r = (s / core::f64::consts::PI).sqrt();
            let k_series = if i + 1 < nth { kv } else { kvt };
            let ell = loss_mult * k_series * dt / (rho * r);
            let den = 1.0 + 0.5 * ell * asum;
            // series corrections may shorten a cell by at most 7 % (the bore grid
            // keeps a matching CFL margin, engine::CFL_MARGIN)
            let dxe = dx + self.dl_half[i].max(-0.07 * dx);
            let (c, l) = lane(i);
            let b = &mut self.blk[c];
            b.c1[l] = ((1.0 - 0.5 * ell * asum) / den) as f32;
            b.c2[l] = (dt * s / (rho * dxe) / den) as f32;
            b.c3[l] = (ell / den) as f32;
        }
        let ntb_old = self.ntb;
        self.ntb = if nth > 1 { (nth + L - 1) / L } else { 0 };
        for i in 0..n {
            let sl = if i > 0 { self.s_half[i - 1] } else { 0.0 };
            let sr = if i < n - 1 { self.s_half[i] } else { 0.0 };
            let mut v = 0.5 * dx * (sl + sr);
            self.vol[i] = v;
            if let Some(ev) = extra_vol {
                if i < ev.len() {
                    v += ev[i];
                }
            }
            let kpi = rc2 * dt / v.max(1e-12);
            self.kp[i] = kpi as f32;
            let interior = i >= 1 && i + 1 < n;
            let (c, l) = lane(i);
            if interior {
                self.blk[c].kq[l] = kpi as f32;
            }
            if c < self.ntb {
                let tb = &mut self.tblk[c];
                if i >= 1 && i < nth {
                    let sn = 0.5 * (sl + sr);
                    let rn = (sn / core::f64::consts::PI).sqrt().max(1e-4);
                    let ell_t = loss_mult * kpi * kt * sn * dx / rn;
                    let den = 1.0 + 0.5 * ell_t * asum;
                    tb.q1[l] = ((1.0 - 0.5 * ell_t * asum) / den) as f32;
                    tb.q2[l] = (kpi / den) as f32;
                    tb.q3[l] = (ell_t / den) as f32;
                } else {
                    // lossless lane inside a thermal block (or an end node: gain 0)
                    tb.q1[l] = 1.0;
                    tb.q2[l] = if interior { kpi as f32 } else { 0.0 };
                    tb.q3[l] = 0.0;
                    tb.t0[l] = 0.0;
                    tb.t1[l] = 0.0;
                    tb.t2[l] = 0.0;
                }
            }
        }
        // thermal blocks dropped from the thermal range: forget their states
        for c in self.ntb..ntb_old.min(self.nb) {
            let tb = &mut self.tblk[c];
            tb.t0 = [0.0; L];
            tb.t1 = [0.0; L];
            tb.t2 = [0.0; L];
        }
        for c in 0..self.ntb {
            for l in 0..L {
                if c * L + l >= n {
                    let tb = &mut self.tblk[c];
                    tb.q1[l] = 1.0;
                    tb.q2[l] = 0.0;
                    tb.q3[l] = 0.0;
                }
            }
        }
    }

    /// U^{n−½} → U^{n+½} at all interior half nodes (reference two-pass form;
    /// the engine uses the fused `step`).
    pub fn step_u(&mut self) {
        let m = self.n - 1;
        let [d0, d1, d2] = self.dk;
        let [e0, e1, e2] = self.ek;
        for i in 0..m {
            let (c, l) = lane(i);
            let b = &mut self.blk[c];
            let sw = e0 * b.w0[l] + e1 * b.w1[l] + e2 * b.w2[l];
            let un = b.c1[l] * self.u[i] - b.c2[l] * (self.p[i + 1] - self.p[i]) + b.c3[l] * sw;
            self.u[i] = un;
            b.w0[l] = un + d0 * b.w0[l];
            b.w1[l] = un + d1 * b.w1[l];
            b.w2[l] = un + d2 * b.w2[l];
        }
    }

    /// p^n → p^{n+1} at interior nodes 1..n−2 (end nodes handled by caller;
    /// reference two-pass form).
    pub fn step_p_interior(&mut self) {
        let n = self.n;
        if n < 3 {
            return;
        }
        let nth = self.thermal_nodes.min(n - 1).max(1);
        let [d0, d1, d2] = self.dk;
        let [e0, e1, e2] = self.ek;
        for i in 1..nth {
            let (c, l) = lane(i);
            let tb = &mut self.tblk[c];
            let st = e0 * tb.t0[l] + e1 * tb.t1[l] + e2 * tb.t2[l];
            let pn = tb.q1[l] * self.p[i] - tb.q2[l] * (self.u[i] - self.u[i - 1]) + tb.q3[l] * st;
            self.p[i] = pn;
            tb.t0[l] = pn + d0 * tb.t0[l];
            tb.t1[l] = pn + d1 * tb.t1[l];
            tb.t2[l] = pn + d2 * tb.t2[l];
        }
        for i in nth..n - 1 {
            self.p[i] -= self.kp[i] * (self.u[i] - self.u[i - 1]);
        }
    }

    /// Fused time step: `step_u` followed by `step_p_interior` in ONE sweep over
    /// 4-node blocks. Block c computes U_{i+½}^{n+½} for i = 4c..4c+3 and then —
    /// with U_{4c−½} carried in a register — p_i^{n+1}; end nodes and padding
    /// have zero gain, so p₀ and p_{n−1} are left to the caller. The arithmetic
    /// is that of the two-pass form except that on aarch64 the multiply-adds are
    /// fused (≤ ½ ulp per operation).
    #[inline]
    pub fn step(&mut self) {
        use f4::*;
        let nb = self.nb;
        let ntb = self.ntb.min(nb);
        debug_assert!(self.blk.len() >= nb && self.tblk.len() >= ntb);
        debug_assert!(self.u.len() >= L * nb && self.p.len() >= L * nb + 1);
        let [d0, d1, d2] = self.dk;
        let [e0, e1, e2] = self.ek;
        let (vd0, vd1, vd2, ve0, ve1, ve2) = (splat(d0), splat(d1), splat(d2), splat(e0), splat(e1), splat(e2));
        // SAFETY: block c touches u[4c..4c+4], p[4c..4c+5], blk[c], tblk[c] with
        // c < nb (resp. ntb), all in bounds by the assertions above / `resize`.
        unsafe {
            let p = self.p.as_mut_ptr();
            let u = self.u.as_mut_ptr();
            let blk = self.blk.as_mut_ptr();
            let tblk = self.tblk.as_mut_ptr();
            // U update of block c; returns (U^{n+½}, pⁿ of the block's nodes)
            let u_blk = |c: usize| -> (V, V) {
                let i = c * L;
                let b = blk.add(c);
                let pi = ld(p.add(i));
                let dp = sub(ld(p.add(i + 1)), pi);
                let (a0, a1, a2) = (ld((*b).w0.as_ptr()), ld((*b).w1.as_ptr()), ld((*b).w2.as_ptr()));
                let sw = mla(mla(mul(ve0, a0), ve1, a1), ve2, a2);
                let un = mla(mls(mul(ld((*b).c1.as_ptr()), ld(u.add(i))), ld((*b).c2.as_ptr()), dp), ld((*b).c3.as_ptr()), sw);
                st(u.add(i), un);
                st((*b).w0.as_mut_ptr(), mla(un, vd0, a0));
                st((*b).w1.as_mut_ptr(), mla(un, vd1, a1));
                st((*b).w2.as_mut_ptr(), mla(un, vd2, a2));
                (un, pi)
            };
            let mut prev = splat(0.0);
            // blocks with thermal (explicit shunt-loss) lanes
            for c in 0..ntb {
                let (ur, pi) = u_blk(c);
                let du = sub(ur, shift_in(prev, ur));
                let t = tblk.add(c);
                let (a0, a1, a2) = (ld((*t).t0.as_ptr()), ld((*t).t1.as_ptr()), ld((*t).t2.as_ptr()));
                let st_ = mla(mla(mul(ve0, a0), ve1, a1), ve2, a2);
                let pn = mla(mls(mul(ld((*t).q1.as_ptr()), pi), ld((*t).q2.as_ptr()), du), ld((*t).q3.as_ptr()), st_);
                st(p.add(c * L), pn);
                st((*t).t0.as_mut_ptr(), mla(pn, vd0, a0));
                st((*t).t1.as_mut_ptr(), mla(pn, vd1, a1));
                st((*t).t2.as_mut_ptr(), mla(pn, vd2, a2));
                prev = ur;
            }
            // lossless blocks
            let mut c = ntb;
            while c + 2 <= nb {
                let (ur, pi) = u_blk(c);
                let (ur2, pi2) = u_blk(c + 1);
                let du = sub(ur, shift_in(prev, ur));
                let du2 = sub(ur2, shift_in(ur, ur2));
                st(p.add(c * L), mls(pi, ld((*blk.add(c)).kq.as_ptr()), du));
                st(p.add(c * L + L), mls(pi2, ld((*blk.add(c + 1)).kq.as_ptr()), du2));
                prev = ur2;
                c += 2;
            }
            if c < nb {
                let (ur, pi) = u_blk(c);
                let du = sub(ur, shift_in(prev, ur));
                st(p.add(c * L), mls(pi, ld((*blk.add(c)).kq.as_ptr()), du));
            }
        }
    }

    /// Stored acoustic energy (J) — used by passivity tests.
    pub fn energy(&self, air: &Air) -> f64 {
        let rho = air.rho;
        let rc2 = rho * air.c * air.c;
        let mut e = 0.0;
        for i in 0..self.n {
            let v = self.vol[i];
            e += 0.5 * v / rc2 * (self.p[i] as f64).powi(2);
        }
        for i in 0..self.n - 1 {
            let l = rho * self.dx / self.s_half[i];
            e += 0.5 * l * (self.u[i] as f64).powi(2);
        }
        e
    }

    /// True if any state is non-finite or absurdly large.
    pub fn is_bad(&self) -> bool {
        let lim = 1.0e7f32;
        self.p.iter().any(|x| !(x.abs() < lim)) || self.u.iter().any(|x| !(x.abs() < 10.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tube(n: usize, len: f64, fs: f64, area: impl Fn(f64) -> f64, loss: f64) -> (Tube, Air) {
        let air = Air::at(20.0);
        let mut t = Tube::with_capacity(n);
        t.resize(n);
        let dx = len / (n - 1) as f64;
        for i in 0..n - 1 {
            t.s_half[i] = area((i as f64 + 0.5) * dx);
        }
        t.set_coeffs(dx, 1.0 / fs, &air, loss, None);
        (t, air)
    }

    /// Lossless tube closed at both ends (rigid: U=0 at the boundaries — the
    /// end nodes just integrate the adjacent half-node flow).
    fn step_closed(t: &mut Tube) {
        t.step_u();
        t.step_p_interior();
        let n = t.n;
        t.p[0] -= t.kp[0] * t.u[0];
        t.p[n - 1] += t.kp[n - 1] * t.u[n - 2];
    }

    #[test]
    fn lossless_closed_tube_no_growth() {
        let fs = 192000.0;
        let len = 1.0;
        let c = Air::at(20.0).c;
        let n = (len / (Air::c_max() / fs)).floor() as usize + 1;
        // a conical-ish varying profile to exercise variable area
        let (mut t, air) = tube(n, len, fs, |x| 1e-4 * (1.0 + 8.0 * x).powi(2), 0.0);
        let _ = c;
        // initial Gaussian pressure pulse
        for i in 0..n {
            let x = i as f64 / (n - 1) as f64;
            t.p[i] = (1000.0 * (-((x - 0.3) / 0.03).powi(2)).exp()) as f32;
        }
        // The discrete energy of the staggered scheme is conserved exactly up to
        // an O(Δt) cross term; the physical energy estimate must stay bounded
        // (no growth) over 1 s ≈ 340 round trips.
        let e0 = t.energy(&air);
        let mut e_max: f64 = 0.0;
        for step in 0..(fs as usize) {
            step_closed(&mut t);
            if step % 997 == 0 {
                e_max = e_max.max(t.energy(&air));
            }
        }
        let e1 = t.energy(&air);
        assert!(e_max < 1.05 * e0, "energy grew: {e0} → max {e_max}");
        assert!(e1 > 0.9 * e0, "lossless tube lost energy: {e0} → {e1}");
        assert!(!t.is_bad());
    }

    #[test]
    fn lossy_tube_decays() {
        let fs = 192000.0;
        let n = (0.7 / (Air::c_max() / fs)).floor() as usize + 1;
        let (mut t, air) = tube(n, 0.7, fs, |_| 2e-4, 1.0);
        for i in 0..n {
            t.p[i] = (1000.0 * (-(((i as f64) - 100.0) / 10.0).powi(2)).exp()) as f32;
        }
        let e0 = t.energy(&air);
        let mut prev = e0;
        for k in 0..20 {
            for _ in 0..10000 {
                step_closed(&mut t);
            }
            let e = t.energy(&air);
            assert!(e <= prev * 1.02, "energy grew at chunk {k}: {prev} → {e}");
            prev = e;
        }
        assert!(prev < 0.9 * e0, "no decay: {e0} → {prev}");
    }

    /// Cylinder closed at x=0, open (p=0) at x=L: resonances (2k−1)c/4L.
    #[test]
    fn cylinder_resonances() {
        let fs = 192000.0;
        let len = 0.5;
        let air = Air::at(20.0);
        let n = (len / (Air::c_max() / fs)).floor() as usize + 1;
        let (mut t, _) = tube(n, len, fs, |_| 2e-4, 0.0);
        let steps = (fs * 0.5) as usize;
        let mut rec = Vec::with_capacity(steps);
        t.p[0] = 1.0;
        for _ in 0..steps {
            t.step_u();
            t.step_p_interior();
            t.p[0] -= t.kp[0] * t.u[0];
            t.p[n - 1] = 0.0;
            rec.push(t.p[0] as f64);
        }
        // DFT magnitude peaks near the analytic resonances
        for k in 1..=4 {
            let f_exact = (2 * k - 1) as f64 * air.c / (4.0 * len);
            let mut best = (0.0, 0.0);
            let mut f = f_exact * 0.97;
            while f < f_exact * 1.03 {
                let w = 2.0 * core::f64::consts::PI * f / fs;
                let (mut re, mut im) = (0.0, 0.0);
                for (i, v) in rec.iter().enumerate() {
                    let win = 0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / steps as f64).cos();
                    re += v * win * (w * i as f64).cos();
                    im += v * win * (w * i as f64).sin();
                }
                let m = re * re + im * im;
                if m > best.1 {
                    best = (f, m);
                }
                f += f_exact * 0.0005;
            }
            let cents = 1200.0 * (best.0 / f_exact).log2();
            assert!(cents.abs() < 5.0, "mode {k}: {} vs {} ({cents:.1} cents)", best.0, f_exact);
        }
    }

    /// The fused one-sweep kernel equals the two-pass reference (step_u then
    /// step_p_interior) for every node count mod 4, with and without thermal
    /// nodes, and leaves the end nodes to the caller.
    #[test]
    fn fused_step_matches_two_pass() {
        let air = Air::at(20.0);
        for n in [9usize, 10, 11, 12, 37, 64, 101] {
            for nth in [0usize, 1, 2, 5, 8, n - 1] {
                let mut t = Tube::with_capacity(n);
                t.resize(n);
                t.thermal_nodes = nth;
                let dx = 0.5 / (n - 1) as f64;
                for i in 0..n - 1 {
                    t.s_half[i] = 1e-4 * (1.0 + 3.0 * i as f64 / n as f64);
                }
                let ev: Vec<f64> = (0..n).map(|i| if i % 7 == 3 { 2e-7 } else { 0.0 }).collect();
                t.set_coeffs(dx, 1.0 / 192000.0, &air, 1.0, Some(&ev));
                for i in 0..n {
                    t.p[i] = (100.0 * ((i as f64) * 0.7).sin()) as f32;
                }
                let mut r = t.clone();
                let (p0, pn) = (t.p[0], t.p[n - 1]);
                let mut md = 0.0f32;
                for _ in 0..50 {
                    t.step();
                    r.step_u();
                    r.step_p_interior();
                    for i in 0..n {
                        md = md.max((t.p[i] - r.p[i]).abs());
                    }
                    for i in 0..n - 1 {
                        md = md.max(1e3 * (t.u[i] - r.u[i]).abs());
                    }
                }
                assert!(md < 1e-3, "n={n} nth={nth}: max deviation {md}");
                assert_eq!((t.p[0], t.p[n - 1]), (p0, pn), "end nodes must be left to the caller");
                assert!(t.u[n - 1..].iter().all(|&x| x == 0.0), "padding U must stay 0");
            }
        }
    }
}
