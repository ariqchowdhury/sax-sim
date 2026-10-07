# Physics specification — alto saxophone + player

Owner: acoustics. Audience: the Rust engine (`engine/`) and, for §8 (keywork) and the geometry
conventions, the web app. Everything is SI unless stated. Equation numbers (E1…) are referenced
by the code and by `docs/VALIDATION.md`.

The Python reference (`tools/tmm.py`) implements the **same** constitutive models in the
frequency domain (bore losses, tone-hole network, radiation, reed compliance, keywork) so that
any disagreement between engine and TMM is a discretisation/implementation issue, not a
modelling one.

Contents
0. Conventions, air properties
1. Bore: Webster equation, grid, CFL
2. Visco-thermal losses
3. Tone holes (side branches, pads)
4. Radiation and the listener signal
5. Reed (a) lumped, (b) distributed beam
6. Reed-channel flow
7. Air source: lungs, glottis, vocal tract, tongue
8. Keywork (keys → pads) — data-driven rule format
9. Mouthpiece shape parameters (params 13–18)
10. Numerical defaults summary and validation checklist

---------------------------------------------------------------------------------------------

## 0. Conventions and air properties

* `x` = axial coordinate along the bore centreline, from the **reed tip** (x = 0) to the bell
  rim (`bell.end_x`, ≈ 1.10 m). Bends are ignored acoustically (x = arc length).
* Pressure `p` = acoustic over-pressure (Pa) relative to atmosphere; volume velocity `U` (m³/s)
  positive toward the bell. Reed displacement `y` positive **toward the lay (closing)**.
  Reed-channel opening `h = H0 − y` (≥ 0 for flow). Mouth pressure `p_m`, mouthpiece pressure
  `p_0` (first bore node), `Δp = p_m − p_0`.
* Geometry JSON conventions (frame, hole angles, centrelines): see `meta.conventions` in
  `data/alto_sax.json`; summary: +y up, bell opens toward +z, player at −z, the whole
  centreline is in the plane X = 0; hole direction `d(θ) = cos θ·n + sin θ·X̂`, `n = t × X̂`.

**Air (E0)** — Keefe (1984), ΔT = T − 26.85 °C, dry air, 1 atm:

| quantity | formula | 22 °C |
|---|---|---|
| c | 347.23 (1 + 0.00166 ΔT) m/s | 344.4 |
| ρ | 1.1769 (1 − 0.00335 ΔT) kg/m³ | 1.196 |
| η (shear viscosity) | 1.846e-5 (1 + 0.0025 ΔT) Pa·s | 1.824e-5 |
| γ | 1.4017 (1 − 0.00002 ΔT) | 1.4018 |
| ν = √Pr | 0.8410 (1 − 0.0002 ΔT) | 0.8418 |

`temperature` (param 19) sets the **bore** air. Real playing fills the bore with humid breath at
~ 28–32 °C (Benade 1976): that raises c by ≈ 1–2 % (+20…35 cents) — this is the physical tuning
drift the slider should show; the geometry is tuned at 22 °C so the default plays at A = 440.
The vocal tract always uses 37 °C, saturated (c ≈ 353 m/s, ρ ≈ 1.11 kg/m³).
Humidity (optional): c increases ≈ 0.1 %/10 % RH at 22 °C; ignore unless needed.

Implementation notes: recompute all grid coefficients when T changes (smoothed param), not per
sample. Validation: `tools/tmm.py --all --temp 30` gives the expected sharpening (≈ +23 cents at 30 °C).

---------------------------------------------------------------------------------------------

## 1. Bore: Webster horn equation on a staggered grid

**Governing equations (E1)** — plane-wave (1-D) propagation in a duct of slowly varying
cross-section `S(x)`, in pressure / volume-velocity form (lossless part):

    (ρ/S) ∂U/∂t + ∂p/∂x = −(series loss, §2)
    (S/ρc²) ∂p/∂t + ∂U/∂x = −(shunt loss, §2) − Σ_holes U_h δ(x − x_h)

**Grid**: pressure at integer nodes `x_i = iΔx`, `i = 0…N`; volume velocity at half nodes;
leap-frog in time (`p` at integer, `U` at half time steps) — Bilbao (2009) *Numerical Sound
Synthesis* ch. 9; Bilbao & Harrison (2016).

    U_{i+½}^{n+½} = U_{i+½}^{n−½} − (Δt S_{i+½}/(ρΔx)) (p_{i+1}^n − p_i^n)          (E1a)
    p_i^{n+1}    = p_i^n − (ρc²Δt / V_i) (U_{i+½}^{n+½} − U_{i−½}^{n+½} + Σ U_branch)  (E1b)
    V_i = Δx (S_{i−½} + S_{i+½})/2    (end nodes: half cells)

`S_{i+½} = π r(x_{i+½})²` using the equivalent-area radius profile (linear interpolation of the
radius between profile samples, which is what the TMM uses — frusta).

**CFL / Δx**: stable for `λ = cΔt/Δx ≤ 1` for any area profile (energy argument). Choose
`N = ceil(L/(cΔt))`, `Δx = L/N` so that λ is as close to 1 as possible (minimum numerical
dispersion). At the default internal rate 4 × 48 kHz = 192 kHz and 22 °C: `cΔt = 1.79 mm`,
L ≈ 1.10 m → N ≈ 615 nodes. At 2× oversampling (96 kHz) N ≈ 308 — still fine up to ~5 kHz
(dispersion error ∝ (1−λ²)(kΔx)², ~1 cent at 1 kHz for λ ≥ 0.98).

When the column length changes (mouthpiece insertion, temperature), keep N fixed while
λ stays in [0.90, 1.0]; otherwise re-grid (with state interpolation) — re-gridding on every
small change produces clicks.

**Hole snapping**: a hole at `x_h` lies between nodes i and i+1 with fraction α. Do *not* round
to the nearest node (±Δx/2 = ±0.9 mm ⇒ up to ±3 cents for the short C#5 tube; d(cents)/dx ≈
−1731/L_eff cents/m). Instead split the branch: the branch sees `p_h = (1−α)p_i + α p_{i+1}`
and its flow is removed as `(1−α)U_h` from node i and `αU_h` from node i+1. This is the
adjoint pair, therefore passive, and removes the quantisation error.

Implementation notes
* Store `S_{i+½}/(ρΔx)` and `ρc²/V_i` coefficient arrays; closed-hole chimney volumes are added
  to `V_i` (split with the same α weights).
* The mouthpiece section near the tip has radius ≈ 3 mm; nothing special is needed.
* Tests: (1) lossless closed–closed cylinder: modes at `n c / 2L` within 0.1 % (λ = 1);
  (2) lossless cone (apex replaced by a closed node at r = 0.3 mm) open end: modes ≈ `n c/2L'`;
  (3) energy non-increasing with losses on and all terminations passive.

---------------------------------------------------------------------------------------------

## 2. Visco-thermal boundary-layer losses

Large-`r_v` boundary-layer theory (Keefe 1984; Bilbao & Harrison 2016): per unit length

    series impedance  Z′ = jωρ/S + (2/(S r)) √(ρη) √(jω)                          (E2a)
    shunt admittance  Y′ = jωS/(ρc²) + (2(γ−1)/(r ρc²)) S √(η/(ρν²)) √(jω)       (E2b)

which gives the familiar `α ≈ (ω/c)·1.045/r_v`, `r_v = r√(ρω/η)` (≈ 0.01 Np/m at 200 Hz for
r = 12 mm). The TMM uses Keefe's expansion to third order in 1/r_v.

**Time domain (passive)**: `√(jω)` is not rational. Approximate `√s ≈ Σ_k a_k s/(s + b_k)` with
3 first-order sections (each positive-real ⇒ passive), fitted over 80 Hz–5 kHz to ±10 %. The
engine's current constants (`fdtd.rs` LOSS_A/LOSS_B) are acceptable. Each section is one state
per half node (series) / node (shunt), updated exactly (one-pole) or trapezoidally.
Bilbao & Harrison (2016) show this form remains passive on the staggered grid when the loss
term is centred (trapezoidal) in time.

Simplification allowed: lump the thermal term into the series resistance with factor
`(1 + (γ−1)/ν)` (engine does this). The total attenuation matches E2 to first order; the
characteristic impedance differs by < 0.3 % — acceptable.

Validation: impedance peak Q / peak magnitudes of the engine's measured input impedance
(impulse response of the bore driven by a flow source at x = 0, all holes closed) vs.
`tools/tmm.py --dump-impedance Bb3 z.csv`: peak frequencies within 5 cents, peak magnitudes within
±1.5 dB below 1.5 kHz.

---------------------------------------------------------------------------------------------

**Real-instrument wall losses (round 7).** Smooth-wall boundary-layer theory under-estimates the
losses of real instruments: measured input-impedance peaks of brass and woodwinds are typically 10–30 %
lower (and resonances correspondingly broader) than smooth-wall predictions, attributed to wall
roughness and lacquer, joints, closed tone-hole and pad-cup cavities and small leaks (Caussé, Kergomard
& Lurton 1984 for brass; Nederveen 1998 and Chaigne & Kergomard 2016 for woodwinds; Chen, Smith & Wolfe
2009 report alto peaks of a few tens of MPa·s/m³). The model multiplies the bore's visco-thermal
losses by `meta.wall_loss_factor` = **1.3** (engine `bore_loss_mult`, `tools/tmm.py`), a frequency-
independent factor on the √ω boundary-layer terms. Effect (TMM, no reed): resonance Q Bb3 66→52,
G4 57→45, C#5 52→41, C6 52→43 (free-decay T60 ≈ 120/f0 → ≈ 95/f0 s), peak magnitudes −20 %
(Bb3 41/62/66 → 33/51/55 MPa·s/m³), pitch −1…−4 cents (retuned); engine onset thresholds +0.04–0.05 kPa;
register locking unchanged after retune (94/99 assist 0, 98/99 assist 0.5). A frequency-dependent
roughness model (loss factor rising when the boundary layer becomes comparable to the roughness height)
would need a measured alto impedance curve to calibrate and is not attempted.

## 3. Tone holes

Each of the 23 holes in `tone_holes` is a short side branch (chimney height `t ≈ 3.5–6.5 mm`,
radius `b`) joined to the bore with volume-velocity conservation (E1b `Σ U_branch`).
Because `k(t + corrections) ≪ 1` below ~4 kHz, a lumped branch is accurate:

**Open (or partly open) hole** — series acoustic mass + resistances feeding a radiation load:

    p_h = (L_h + L_pad(h)) dU_h/dt + (R_bl + R_pad(h) + R_nl|U_h|) U_h + Z_rad * U_h      (E3)

| term | value | source |
|---|---|---|
| `L_h` | `ρ (t + t_i + t_m) / S_h`, `S_h = πb²` | |
| inner correction `t_i` | `b(0.82 − 0.193δ − 1.09δ² + 1.27δ³ − 0.71δ⁴)`, `δ = b/a` | Dalmont et al. 2002 |
| matching volume `t_m` | `bδ(1 + 0.207δ³)/8` (add to L_h; optional, ≤ 1 mm) | Nederveen 1998 |
| pad curtain `L_pad` | `ρ · 0.12 b²/h / S_h` (h = openness·`pad_open_height`) — = 0.3 b of extra length at h = 0.4 b | Nederveen 1998, Dalmont et al. 2001 (approx.) |
| radiation `Z_rad` | parallel R_r ∥ L_r: `L_r = ρ·0.70 b/S_h`, `R_r = Z_ch·0.70²/κ`, κ = 1/3 | hole in a tube wall: between unflanged (0.6133, κ=¼) and flanged (0.8216, κ=½) |
| `R_pad` (nearly closed) | `12 η w_rim / (2π b h³)`, `w_rim ≈ 1 mm` (lubrication flow under the pad) | |
| `R_bl` | chimney boundary-layer resistance at 400 Hz, `(2√(ρη)(1+(γ−1)/ν)/(S_h b)) √(ω/2) (t+t_i)` | |
| `R_nl` | `K ρ |U| / (2 S_e²) · 1/(1 + (St/St_c)²)`, K = 1, `S_e = min(S_h, 2πbh)`, St = ω b / v̂, St_c = 1 (jet separation / vortex shedding at the edge; quasi-steady only when the particle displacement v̂/ω exceeds the edge scale) | Ingard & Ising 1967, Disselhorst & van Wijngaarden 1980, Dalmont et al. 2002, Atig et al. 2004 |

**Closed hole** (openness < 1e-3): the chimney is a closed cavity — add its volume
`V_h = S_h t` (plus a pad-cup recess of ~0.5 mm·S_h if desired) to the compliance of the
adjacent node(s). No mass.

**Series (anti-symmetric) mass** `t_a = −0.47 b δ⁴ /(tanh(1.84 t/b) + 0.62δ² + 0.64δ)` (open)
/ `coth` instead of `tanh` (closed) — Keefe 1990 / Dalmont 2002 — is a < 2-cent effect for
sax holes; the TMM includes it, the engine may omit it.

**Pad dynamics**: target openness comes from §8. Openness moves with first-order lag
τ_close ≈ 6 ms (finger-driven), τ_open ≈ 10 ms (spring-driven). Because `L_pad ∝ 1/h` and
`R_pad ∝ 1/h³`, the branch impedance diverges continuously as the pad closes — the transition
open → closed is smooth (no switching). Switch to the "closed cavity" representation only
below openness 1e-3 (at that point `R_pad` already blocks the flow).

Octave vents (`oct_neck` x = 0.090 m r = 1.4 mm, `oct_body` x = 0.266 m r = 1.8 mm,
`octave_vent: true`) use the same model; for them R_bl and R_nl matter (narrow tube, t/b ≈ 2–3).
The nonlinear jet loss R_nl is physical (Dalmont et al. 2002) and makes the overblown notes play
15–80 cents below the *linear* vented impedance peak — so vent positions/sizes and all register-2
tuning were set with the engine in the loop (`tools/engine_loop.py`), not from TMM alone.

Implementation notes
* The branch and the node pressure must be updated jointly (the engine's trapezoidal joint
  update in `radiation.rs` is correct and unconditionally passive).
* Recompute branch coefficients only when openness changed by > 1e-5.
* Validation: for each first-register fingering, engine playing frequency (or input-impedance
  peak from an impulse test) within ±5 cents of TMM (`python3 tools/tmm.py --all`).

---------------------------------------------------------------------------------------------

## 4. Radiation and the listener signal

**Bell** (rim radius `a = bell.end_radius` = 62 mm): Levine–Schwinger unflanged pipe. Passive
first-order network (the same R ∥ L form; Silva et al. 2009 discuss higher-order fits):

    L_r = ρ·0.6133/(π a),   R_r = Z_c·0.6133²/0.25 = 1.505 Z_c,   Z_c = ρc/(πa²)      (E4)

This matches exactly the low-frequency end correction (0.6133a) and radiation resistance
(Z_c(ka)²/4). The TMM uses the full Norris–Sheng/Silva fit (valid to ka ≈ 3.8); differences
appear only above ~1.5 kHz where the bell radiates efficiently anyway.

**Bell flare — spherical wavefronts (implemented in the data, wave 2)**: in the flare
(`bell.flare_start_x` … `end_x`) the JSON `body.profile` is already the *equivalent* radius of a
spherical-cap wavefront that meets the wall at right angles (Benade & Jansson 1974):
`S_cap = 2π r²/(1 + cos θ)`, θ = wall angle (`tan θ = dr_wall/dx`), i.e. `r_eq = r_wall·√(2/(1+cos θ))`
(+8 % in radius at the rim). Engine and TMM need no change — they read `profile`.
`body.wall_profile` is the physical wall radius (for graphics only). The remaining
approximation is the axial path length along the caps (ignored; < 5 mm).

**Listener** (E4b): monopole sum, far field, listener at `L_pos` (default 1.0 m in front of the
bell rim along `bell.rim_normal`):

    p_out(t) = Σ_k (ρ/(4π d_k)) dU_k/dt (t − d_k/c)

over the bell and every (partly) open hole; `U_k` is the flow through the radiation resistor
branch; `d_k` from `bell.rim_center` / `tone_holes[i].position` to the listener. Use integer-
sample delays at the internal rate (or fractional, linear interpolation). Then decimate with
the polyphase low-pass. Directivity and the hole/bell dipole interaction are ignored.

Validation: radiated spectrum of the bell vs. internal mouthpiece spectrum shows the expected
high-pass (~6 dB/oct below the bell cutoff ≈ 1.2–1.5 kHz).

---------------------------------------------------------------------------------------------

## 5. Reed

### 5a. Lumped single-DOF reed (M1–M3)

    m ÿ + r ẏ + K (y − y_eq) + F_c(y, ẏ) = S_r Δp + F_tongue,      K = k_reed + k_lip      (E5)

Equivalent per-unit-area form (Chaigne & Kergomard 2016): `ÿ + q ω_r ẏ + ω_r²(y−y_eq) = Δp/μ`,
`μ = m/S_r`, `K_a = K/S_r = μ ω_r²`.

**Target values at default embouchure** (reed_strength 2.5, lip_position 12 mm, lip_force 1 N,
lip_damping 0.4) — sources: Dalmont, Gilbert & Ollivier 2003 (clarinet, scaled), Chen, Smith &
Wolfe 2009, Scavone 2008 (sax), Avanzini & van Walstijn 2004:

| quantity | value | comment |
|---|---|---|
| tip opening (unloaded) `H_tip` | `tip_opening` = 1.9 mm | classical alto 1.7–2.1 mm |
| equilibrium opening `H0 = H_tip − y_eq` | 0.9–1.1 mm | lip pre-bends the reed |
| stiffness per area `K_a` | 6–9 × 10⁶ Pa/m | |
| closing pressure `p_M = K_a H0` | 6–9 kPa | threshold of oscillation ≈ p_M/3 ≈ 2–3 kPa (lossless theory) |
| reed resonance `f_r` (lipped) | 1.6–2.2 kHz | measured in situ 1.5–2.5 kHz |
| damping `q = 1/Q` | 0.3–0.5 (lipped) | free reed q ≈ 0.05 |
| effective area `S_r` | 4–7 × 10⁻⁵ m² (area for swept flow ≈ (3/8)·w·ℓ_free) | |
| equivalent volume `V_r = ρc²S_r²/K` | ≈ 1.0 cm³ (TMM: 1.08 cm³, with resonance factor 1/(1 − (f/2 kHz)² + 0.4j f/2 kHz)) | Nederveen 1998 |

**Why this matters**: the reed compliance lowers the upper notes much more than the lower
ones (TMM with a rigid reed: Bb3 +4, C#5 +38, C#6 +65 cents). The geometry is tuned *with*
V_r = 1.08 cm³, so the engine's reed must have that compliance at the default embouchure (check
`ρc²S_r²/K` summed over the tip and body modes) or the upper register will be out of tune.

**Engine constants (reviewed, wave 2 — accepted as the spec)**: `engine/src/reed.rs` uses
S_r = 4.94×10⁻⁵ m² total, split equally (BODY_SHARE = 0.5) between the tip mode and a body
(flexure) mode at 1.5 f_r; k_reed = 221·(0.55 + 0.18 s)·0.5·(20 mm/ℓ)² N/m, k_lip = (20 + 80 F)·0.5 N/m,
lay-support factor 0.55 in y_eq (H0 ≈ 1.03 mm at 1 N), f_r = 1.9 kHz at default. At the default
this gives K_a ≈ 6.5×10⁶ Pa/m, p_M ≈ 6.7 kPa, V_r = 1.08 cm³ (= the TMM value), q ≈ 0.36 — all
inside the table above. Measured onset threshold 2.45–2.6 kPa (VALIDATION.md). Because the web
UI's default blowing pressure is 3 kPa, a threshold nearer 2.0–2.3 kPa would give more margin:
lowering p_M toward 6 kPa (e.g. lay factor or k_lip) is the physically sensible knob.

**Mapping of controls** (the engine's `derive_reed_params` implements an equivalent mapping;
the requirement is that it hits the table above at defaults and has these trends):

* `reed_strength s` (1.5–5): `k_reed ∝ (0.55 + 0.18 s)` (≈ +18 %/strength unit — manufacturer
  charts, uncertain ±30 %); `f_r ∝ √(stiffness)`.
* `lip_position ℓ_p` (mm from tip): free length `ℓ = ℓ_p + 8 mm`; cantilever-on-lay stiffness
  `k_reed ∝ ℓ⁻²` (between plate ∝ℓ⁻³ and lay-supported); `S_r ∝ ℓ^½`; `f_r ∝ ℓ^−0.75`.
  More mouthpiece in the mouth ⇒ softer, lower f_r, louder/brighter, easier low notes.
* `lip_force F` (0–3 N): `y_eq = β F / K` with cantilever moment arm factor
  `β = a²(3L−a)/(2L³)·0.48`, `a = vamp − ℓ_p`, vamp L = 35 mm (calibrated: H0 ≈ 1 mm at 1 N);
  `k_lip = 20 + 80 F` N/m in parallel (lip tissue stiffens with force); `f_r` × √(1 + 0.15(F−1)).
  Biting (F→3 N) closes the reed (H0 → 0): no sound, as in reality.
* `lip_damping d`, `reed_damping d_r`: `q = 0.03 + 0.3 d_r + 0.6 d`.
* Mass: `m = K / ω_r²`; `r = q √(K m)`.

**Beating / lay contact** (Hunt–Crossley penalty, Avanzini & van Walstijn 2004):

    F_c = k_c δ^α (1 + μ_c ẏ)   for δ = y − y_c > 0, else 0                              (E5b)

with α = 2 (curved lay: contact area grows progressively), `y_c` = displacement where the reed
begins to roll onto the facing (`y_c = H_tip − φ H0`, φ ≈ 0.12·facing_length/22 mm), `k_c` such
that the contact adds ≈ 15 K of stiffness at full closure, `μ_c ≈ 0.7 s/m` (restitution ≈ 0.3
at tip speeds ~1 m/s). Channel opening for the flow `h = max(H_tip − y, 0)`.
Keep the residual flexural mode ("body mode": the reed between lip and tip keeps bending while
the tip rests on the lay — engine BODY_SHARE) — it preserves part of V_r during closure.

**Tongue** (`tongue_reed_contact c` ∈ [0,1], §7): adds `F_tongue = 1.0·c N` (toward closing),
extra damping `r_t = 6c√(K m)` and reduces the inlet area of the reed channel by `(1 − 0.9c)`.
Tonguing = c going 0→1→0 over ~20–40 ms.

Integration: centred scheme `m δ_tt y + r δ_t· y + K μ_t· y = F` (unconditionally stable for the
linear part; Bilbao 2009), contact linearised about yⁿ. Solve jointly with the flow (§6).

Validation: (i) small-signal reed response peak at f_r with Q = 1/q; (ii) static: Δp = p_M
closes the channel; (iii) oscillation threshold for Bb3 within 2–3.5 kPa (VALIDATION.md).

### 5b. Distributed reed (M4) — Euler–Bernoulli beam with lay and lip contact

Avanzini & van Walstijn (2004), Acta Acustica 90: 537–547. Coordinate ξ from the reed tip
(ξ = 0) to the ligature clamp (ξ = L_c ≈ 0.040 m beyond which the reed is clamped):

    ρ_r w e(ξ) ∂²y/∂t² + ∂²/∂ξ² [ E I(ξ) (1 + η_r ∂/∂t) ∂²y/∂ξ² ] + γ_r ρ_r w e ∂y/∂t
        = w_p Δp(ξ,t) + f_lip(ξ,t) + f_lay(ξ,t)                                         (E5c)

| symbol | value |
|---|---|
| width `w` (reed) / `w_p` (window, pressure-loaded) | 17 mm / 13.5 mm |
| thickness `e(ξ)` | `e_tip + (e_heel − e_tip)(ξ/L_v)^1.4` for ξ ≤ L_v = 35 mm (vamp), = e_heel beyond; e_tip = 0.10 mm, e_heel = 2.8 mm (`mouthpiece.reed`) |
| `I(ξ)` | `w e³/12` |
| E (cane, along grain) | 1.0 × 10¹⁰ Pa (range 6–12 GPa); scale E with reed_strength exactly as k_reed in §5a |
| ρ_r | 500 kg/m³ |
| η_r (Kelvin-Voigt) | 6 × 10⁻⁷ s |
| γ_r (air/fluid damping) | 100 s⁻¹ |
| Δp(ξ) | p_m − p_0 over the window (ξ < window_length = 30 mm), 0 under the lip |

**Lay profile** (height of the facing above the table plane, measured from the facing break
point at distance `F_L = facing_length` from the tip):

    y_lay(ξ) = tip_opening · ((F_L − ξ)/F_L)^2    for 0 ≤ ξ ≤ F_L,   0 beyond               (E5d)

Here `y(ξ)` is the reed deflection toward the mouthpiece measured from its unloaded position (the
unloaded reed is straight and lies on the table plane behind the break point, so the gap to the
facing at rest is `y_lay(ξ)`, = tip_opening at the tip). Gap `g(ξ) = y_lay(ξ) − y(ξ)`; contact
where `g < 0`.
Contact force per unit length `f_lay = −k_lay (−g)^1.5 − r_lay ∂y/∂t` for g < 0;
`k_lay ≈ 10¹⁰ N/m^2.5`, r_lay ≈ 2 N·s/m² was the original spec; **as implemented (wave 3)**
`k_lay = 10⁹`, `r_lay = 300` (engine units): the spec values made the contact chatter at the internal
rate. The softer penalty lets the reed penetrate the lay by a few µm (harmless). Known issue: the beam
reed (param reed_model = 1) plays upper notes sharp (C#5 +28, D6 +69 cents) and locks registers less
well than the lumped reed, which stays the default.

**Lip**: distributed Kelvin–Voigt foundation over a contact length `ℓ_lip = 10 mm` centred at
`lip_position`: `f_lip = −k_l (y − y_lip) − r_l ∂y/∂t` with `k_l = (2 + 6 F)·10⁵ N/m²`,
`r_l = (20 + 150 d)` N·s/m² (d = lip_damping; gives first-mode q ≈ 0.3–0.5 at the default —
calibrate against §5a);
the lip "position" `y_lip` is set by `lip_force` (static equilibrium: ∫ k_l (y_lip − y) dξ = F).

**Boundary conditions**: clamped at ξ = L_c (y = ∂y/∂ξ = 0); free at the tip (moment and shear
zero).

**Numerics**: the beam is stiff — explicit stability needs `Δt ≤ Δξ²/(2√(EI/ρA))` ≈ 0.2 µs for
Δξ = 1 mm — so use an implicit θ-scheme (θ = ¼, Newmark/Crank–Nicolson; unconditionally stable)
with N_ξ ≈ 30–40 nodes; the system is pentadiagonal (banded LU per step, ~ 40×9 flops). Contact:
treat the penalty implicitly with one Newton iteration (or the non-iterative linearisation of
Avanzini & van Walstijn). The reed couples to the flow through the tip opening
`h = g(0)` and the swept flow `U_r = w_p ∫ ∂y/∂t dξ` over the window.

Validation: first in-vacuo mode of the free (unlipped) reed ≈ 1–1.5 kHz (alto reed ~ 1.2 kHz),
second ≈ 4–6 kHz; lipped first mode 1.6–2.2 kHz; static closing pressure matches 5a ±30 %.

---------------------------------------------------------------------------------------------

## 6. Reed-channel flow

Quasi-stationary Bernoulli with flow separation (vena contracta) at the channel exit
(Hirschberg et al. 1990; van Zon et al. 1990):

    U_f = α_vc w h sgn(Δp) √(2|Δp|/ρ),         α_vc ≈ 0.7  (range 0.6–1.0)                  (E6)
    U_in = U_f + S_r ẏ     (reed-swept flow: reed closing pushes air into the mouthpiece)

with `w = vibrating_width` (13.5 mm) and `h = max(H_tip − y, 0)`. Δp may become negative briefly
(reverse flow) — keep the sign. For h → 0 add a viscous term so U_f is smooth:
`Δp = ρU²/(2(α w h)²) + 12 η ℓ_ch U /(w h³)` with ℓ_ch ≈ 3 mm (channel length) — solve the
quadratic for U (positive root by sign).

**Reed-channel flow inertia (tested, OFF)**: the channel air (ℓ_ch ≈ 3–5 mm, section w·h) has
inertance `L_ch = ρ ℓ_ch/(w h)`; implemented implicitly in the engine (`flow.rs`
CHANNEL_INERTIA_LEN, env SAX_LCH) but **off by default**: engine-in-the-loop tables gave 3 → 6 → 8 → 10
register failures for ℓ = 0, 2, 4, 6 mm, and it does not change the (inverse) bifurcation (§11).

**Coupling**: p_0 at node 0 depends on U_in at the same time step (`p_0⁺ = p_tmp + K_0 U_in`,
K_0 = ρc²Δt/V_0) — the quadratic in `√|Δp|` has a closed-form solution (engine `solve_orifice`).
Mouth pressure p_m is the pressure at the mouth end of the vocal-tract grid (§7), which in turn
receives −U_f.

**Turbulence noise** (`breath_noise` 0–1): add to U_f a noise flow
`U_n = 0.1·breath_noise · U_f · ξ(t)`, ξ = unit-variance white noise band-passed 1–8 kHz,
only while the jet Reynolds number `Re = U_f/(w ν_kin) > 1200`.

Validation: the static curve `U(Δp) = α w H0 (1 − Δp/p_M) √(2Δp/ρ)` has its maximum at
Δp = p_M/3, `U_max = (2/3) α w H0 √(2p_M/(3ρ))` ≈ 0.4 L/s at the defaults (p_M ≈ 8 kPa); mean
flow while playing mf is typically 0.1–0.3 L/s.

---------------------------------------------------------------------------------------------

## 7. Air source: lungs, glottis, vocal tract, tongue

**Lungs**: pressure `P_L` follows the target (param 0, kPa) with first-order respiratory
dynamics τ = 60 ms (attack) / 120 ms (release). Unlimited air supply.

**Subglottal system (round 7, param `subglottal` = 1, default)**: trachea + bronchial tree as a
1-D lossy transmission line (`tract.rs` `Subglottal`) of the *total* cross-section of Weibel's (1963)
symmetric airway model A, generations 0–9 (2^g ducts each; lengths × 0.87, diameters as published:
trachea 10.4 cm × 2.5 cm², path 21.4 cm, total area 2.5 → 9.5 cm²). Per unit length: inertance ρ/A;
visco-thermal boundary-layer resistance of the parallel ducts `P_d/(N a_d²)·√(ωρη/2)·(1 + (γ−1)/ν)`
(thermal part lumped into the series branch as in E2, evaluated at 1 kHz: frequency-independent, and
no shunt leak of the static pressure); yielding walls per node (area N·π·d·Δx) with
m_w = 8 kg/m², b_w = 10⁴ Pa·s/m, k_w = 10⁷ Pa/m (soft-tissue mass/resistance after Ishizaka et al.
1975/76; cartilage-stiff statically). Below generation 9 the tree is a resistive termination ρc/A_9,
through which the lung pressure drives the system; the steady drop (R_term + ΣR)·Ū_g is compensated
at the source so the lung-pressure param keeps meaning the subglottal operating pressure.
Leapfrog at the internal rate, Δx ≈ 10 mm (22 nodes, dispersion < 1 % below 2.5 kHz), solved jointly
with the glottal orifice each step. Input impedance at the glottis: Sg1–Sg3 = 535/1405/2275 Hz,
5.9/5.8/3.9 MPa·s/m³, bandwidths 150/165/220 Hz (literature: ≈ 550–650, 1350–1550, 2200–2400 Hz
with substantial damping — Fant; Ishizaka et al. 1976 JASA 60; Lulich 2010). With an open glottis
these couple into the tract seen from the reed (extra peaks near 270, 620–820 Hz and 1.6 kHz, and the
tract's own peaks are less damped than with an anechoic load); a narrowed glottis (≲ 0.1 cm²)
decouples them. `subglottal` = 0 restores the old anechoic load ρc/S_trachea (S = 2.5 cm²).

**Glottal section of the tract (round 4)**: the first ~4–5 mm (one grid cell) of the tract area function
is the glottal slit itself, area A_g from `glottis_open` (0.05–2.0 cm²). Its inertance ρℓ/A_g makes the
glottal end reflective when the glottis is narrowed, which raises high-front-tongue tract peaks near
1 kHz from ~55 to ~85 MPa·s/m³ at A_g ≈ 0.15 cm² — needed for altissimo (VALIDATION.md §5).

**Glottis**: orifice between lungs and trachea/tract with area
`A_g = A_g,min + glottis_open (A_g,max − A_g,min)`, A_g,min = 0.05 cm², A_g,max = 2.0 cm²
(wind players keep the glottis wide; narrowing adds resistance and can couple):

    P_L − p_tract(0) = (ρ/2)(U_g/A_g)² + R_v U_g,   R_v = 12 η ℓ_g / (A_g · d_g²),  ℓ_g = 3 mm, d_g = A_g/(1.8 cm)

**Vocal tract**: Webster FDTD (§1 scheme, losses ×3 for soft walls (wave 3; was ×10, which damped the
resonances far below measured formant bandwidths and player tract peaks) — or add a yielding-wall
shunt `Y_w = 2πr/(m_w s + b_w + k_w/s)` per length, m_w = 21 kg/m², b_w = 8000 kg/(m²s),
k_w = 845 kPa/m (Ishizaka et al. 1975; Story 2005)) of length L_t = 0.17 m (glottis → lips),
20–40 sections (Δx ≈ 4–8 mm is plenty below 4 kHz; can run at a lower rate than the bore).
37 °C saturated air.

**Area function** A(x), x from glottis (0) to the lips/mouthpiece (L_t) — Story/Maeda-style
neutral tract + Gaussian articulator perturbations (all areas in cm²):

    A_n(x):  0–0.020 m: 1.8 (larynx tube) → 0.020–0.075: 3.5 (pharynx) → 0.075–0.095: 2.8 (velum)
             → 0.095–0.150: 3.0 + 2.5·jaw_open (oral cavity) → 0.150–0.170: 2.0 + 2.0·jaw_open (front/teeth)
    tongue body:  centre x_c = 0.065 + 0.075·(1 − tongue_x)   (tongue_x = 0 front/palatal ⇒ x_c = 0.14,
                  1 back/pharyngeal ⇒ x_c = 0.065),  width σ = 0.020·(1 + tongue_length) m (round 7:
                  a bunched tongue raised along the palate forms a long narrow channel, 2 → 4 cm)
                  A ← A·(1 − 0.97·tongue_y·G(x)),  G = exp(−(x − x_c)²/(2σ²))
    tongue tip:   centre 0.158 m, σ = 0.006 m, A ← A·(1 − 0.9·tongue_tip·G_tip)
    floors:       A ≥ 0.10 cm² (tongue body), ≥ 0.15 cm² (tip); never 0 (no full closure)
    mouth end:    the lips seal on the mouthpiece; the last section is a cavity of ~2–4 cm² that
                  feeds the reed channel only (closed end except U_f).

Typical results: oral volume 30–70 cm³; first tract resonances ≈ 300–600 Hz (low tongue,
open jaw) up to ≈ 1–1.5 kHz (high front tongue, "ee" vowel).

**Physics to preserve** (Scavone, Lefebvre & da Silva 2008 JASA 123; Chen, Smith & Wolfe 2008
Science 319 (clarinet); Chen et al. 2009/2011 sax): the reed is driven by `p_m − p_0`, so the
tract impedance `Z_t` in series with the bore `Z_b` matters: notes are supported near peaks of
`Z_b + Z_t`. Saxophonists tune a tract resonance with |Z_t| ~ 10–30 MPa·s/m³ close to the
desired note to play altissimo and to bend pitch downward (by up to a semitone or more in the
2nd register). Therefore the tract **must** be an acoustic system (not a constant pressure) and
its losses must be modest enough that |Z_t| peaks reach ≥ 10 MPa·s/m³ for a high, front tongue.

**Tongue–reed contact**: see §5a (force + damping + inlet blockage). The tongue tip position
for articulation is the same as `tongue_tip` (the 3D view should move the tip to the reed).

Implementation notes: changes in the area function must be smoothed (≥ 10 ms) to avoid clicks;
recompute coefficients at control rate. Validation: impulse-response of the tract (closed at the
reed end, glottis open) shows Z_t peaks in the ranges above; pitch bend of a 2nd-register note
by moving tongue_y up with tongue_x front ≥ 30 cents.

---------------------------------------------------------------------------------------------

## 8. Keywork — data-driven rule format (Rust `keywork.rs` ≡ TS `keywork.ts` ≡ `tmm.py`)

Inputs: press amount `p_k ∈ [0,1]` for every key in `keys[]` (0 = untouched). Output: target
openness `o_h ∈ [0,1]` for every hole in `tone_holes[]` (1 = fully open).

**Rules**: an ordered list =

1. for each key (array order), for each of its `actions` (array order):
   `{ "when_all": [key.id], "hole": action.hole, "set": action.set }`
2. then every entry of `linkages` (array order). A linkage has
   `{ "id", "when_all"?: [keys], "when_any"?: [keys], "unless_any"?: [keys], "hole", "set": "open"|"closed", "note"? }`.

**Evaluation**:

    o_h ← 1 if pad_rest(h) == "open" else 0                                 for all h
    for rule in rules:
        a = 1
        if when_all non-empty:  a = min(a, min_{k∈when_all} p_k)
        if when_any non-empty:  a = min(a, max_{k∈when_any} p_k)
        (when_all and when_any both empty ⇒ a stays 1: the rule is always active, modulo unless_any)
        if unless_any non-empty: a = a · (1 − max_{k∈unless_any} p_k)
        target = 1 if set == "open" else 0
        o_h(rule.hole) = o_h · (1 − a) + target · a

For binary inputs this is plain boolean logic with "later rules override earlier ones"; for
partial presses it interpolates continuously (half-pressed key → half-closed pad). Physical pad
height = `o_h · pad_open_height`, then pad dynamics (§3).

**Mechanism encoded in `data/alto_sax.json`** (modern Selmer-type alto):

| hole (pad) | rest | direct key(s) | linkages |
|---|---|---|---|
| `C` (top LH pad; open ⇒ C#5) | open | – | closed by LH1 or LH2 |
| `B` | open | LH1 closes | |
| `Bb_bis` (small Bb pad) | open | BIS closes, side Bb closes | closed by LH2 (A key) and by RH1/RH2 ("1-and-1" Bb) |
| `A` | open | LH2 closes | |
| `G` | open | LH3 closes | |
| `Gs` | closed | G# key opens | forced closed by RH1/RH2/RH3/low C#/low B/low Bb (articulated G#) |
| `Fs` (F# pad; open ⇒ G4) | open | – | closed by RH1, RH2 or RH3 |
| `F`, `E`, `D` | open | RH1, RH2, RH3 close | |
| `low_Eb` | closed | RH pinky Eb opens | |
| `low_C` | open | RH pinky C closes | closed by low C#, low B, low Bb |
| `low_Cs` | closed | LH pinky C# opens | kept closed by low B / low Bb |
| `low_B` | open | LH pinky B closes | closed by low Bb |
| `low_Bb` | open | LH pinky Bb closes | |
| `palm_D`, `palm_Eb`, `palm_F` | closed | palm keys open (front F also opens `palm_F`) | |
| `side_E`, `side_C`, `high_Fs` | closed | RH side E / side C / high F# open | |
| `oct_neck` | closed | – | open when OCT pressed **unless** LH3 pressed |
| `oct_body` | closed | – | open when OCT **and** LH3 pressed |

**Octave logic** (`octave_logic` string): the automatic octave mechanism is just the last two
linkages — with fractional inputs `a_neck = p_OCT (1 − p_LH3)`, `a_body = min(p_OCT, p_LH3)`.
D5–G#5 (LH3 down) use the body vent; A5 and above (LH3 up) the neck vent.

Each hole also carries `vents`: the written note it sounds as the uppermost open hole (register
1; palm/side keys: register 2) — useful for UI labels.

Conformance test (all three implementations): `python3 tools/tmm.py --keys LH1,LH2,LH3,RH2`
prints the open holes; the Rust and TS unit tests should reproduce the openness vectors for every
entry of `fingerings` and `alternate_fingerings` (hard-code a few from the TMM output).

---------------------------------------------------------------------------------------------

## 9. Mouthpiece shape parameters (params 13–18)

The JSON `mouthpiece.profile` is the **nominal** equivalent-area radius (defaults: tip 1.9 mm,
facing 22 mm, baffle 0.3, chamber 0.5, throat 11 mm, insertion 10 mm). Landmarks are given in
`mouthpiece.baffle_end`, `chamber_start`, `chamber_end`, `throat_x`. Perturbations (implemented in
`engine/src/geometry.rs::mp_radius`; adopted as the spec):

* **baffle_height b**: area factor in `0 ≤ x < baffle_end` of `1 + w_b(x)·(f(b)/f(0.3) − 1)`,
  `f(b) = 1 − 0.45 b`, `w_b` = smooth bump. High baffle ⇒ smaller area just behind the tip ⇒
  stronger upper partials (brighter) and slightly sharper upper register.
* **chamber_size c**: area factor `1 + w_c(x)(g(c)/g(0.5) − 1)`, `g(c) = 0.6 + 0.8 c`, in
  `[chamber_start, chamber_end]`. Mouthpiece volume ≈ 8.9 cm³ (c = 0) … 13.7 cm³ (c = 1),
  nominal 11.3 cm³ (c = 0.5). Bigger chamber ⇒ upper register flatter relative to lower (the octave
  "stretch" shrinks) and darker tone — this is the classic Benade missing-cone trade-off.
* **throat_diameter d**: radius × `1 + w_t(x)(d/11 mm − 1)`, cosine window ±0.2·L_mp around
  `throat_x`.
* **tip_opening / facing_length**: change the reed (§5) — H_tip and the lay curve E5d; the bore
  area at x = 0 can be scaled by `√(tip_opening/1.9 mm)` (minor).
* **mouthpiece_insertion i**: the mouthpiece slides on the cork: the air column shortens by
  `(i − 10 mm)`; keep the mouthpiece profile and shift the neck/body (engine `insertion_shift`).
  Pushing the mouthpiece further on (larger i) shortens the column and makes the instrument
  SHARPER: ≈ +1.4 cents per mm (Bb3) … +3.3 cents per mm (C#5) (TMM); e.g. +9 mm ≈ +15…+30 cents.

Volume sanity: the nominal mouthpiece volume is 11.3 cm³ plus the reed equivalent volume
1.1 cm³. This is larger than the static "missing cone apex" volume (≈ 5–7 cm³) because the
criterion that matters is harmonicity of the resonances over the playing range, not the
low-frequency limit (Benade 1976; Nederveen 1998). Neck taper (exponent 0.66, entry ID 10.4 mm),
mouthpiece baffle/chamber radii (6.6 / 9.3 mm) and bell flare (0.285 m, exponent 5.6) were chosen by
`tools/design_harmonicity.py` (f2/2f1 within −14…+15 cents for all register-1 fingerings). Real
alto mouthpieces are in the 9–12 cm³ range (uncertain), so this is plausible; the 10.4 mm neck
entry is at the small end of real necks.

## 10. Numerical defaults and validation checklist

| item | default |
|---|---|
| internal rate | 4 × 48 kHz; bore λ ≥ 0.95 |
| bore nodes | ≈ 615 at 192 kHz |
| tract | 0.17 m, ~32 nodes, can run at 48–96 kHz |
| pad τ | 6 ms close / 10 ms open |
| lung τ | 60 ms up / 120 ms down |
| reed (5a) at defaults | H0 ≈ 1.0 mm, f_r ≈ 1.6–2.0 kHz, q ≈ 0.4, V_r ≈ 1 cm³ |
| flow | α_vc = 0.7, w = 13.5 mm |
| listener | 1 m on the bell axis |

Checklist (numbers in `docs/VALIDATION.md`): impedance peaks vs TMM; playing frequency per
fingering vs TMM (±10 c reg 1 / ±20 c reg 2 against ET is the geometry target, engine vs TMM
should agree to ±10 c); threshold 2–3.5 kPa; normal playing 3–6 kPa; pitch drop of a few cents
with increasing blowing at fixed embouchure; temperature +1 °C ≈ +3 cents.

### References
* Avanzini, F. & van Walstijn, M. (2004) Modelling the mechanical response of the reed-mouthpiece-lip system of a clarinet. Part I. Acta Acustica 90, 537–547.
* Benade, A.H. (1976) Fundamentals of Musical Acoustics. Oxford UP.
* Benade, A.H. & Jansson, E.V. (1974) On plane and spherical waves in horns with nonuniform flare. Acustica 31.
* Bilbao, S. (2009) Numerical Sound Synthesis. Wiley. ch. 9 (Webster FDTD).
* Bilbao, S. & Harrison, R. (2016) Passive time-domain numerical models of viscothermal wave propagation in acoustic tubes of variable cross section. JASA 140, 728–740.
* Chaigne, A. & Kergomard, J. (2016) Acoustics of Musical Instruments. Springer.
* Chen, J.-M., Smith, J. & Wolfe, J. (2008) Experienced saxophonists learn to tune their vocal tracts. Science 319, 776; (2009) Saxophone acoustics: introducing a compendium of impedance and sound spectra. Acoustics Australia 37; (2011) Saxophonists tune vocal tract resonances in advanced performance techniques. JASA 129, 415–426.
* Dalmont, J.-P., Gilbert, J. & Ollivier, S. (2003) Nonlinear characteristics of single-reed instruments: quasistatic volume flow and reed opening measurements. JASA 114, 2253.
* Dalmont, J.-P., Nederveen, C.J., Dubos, V., Ollivier, S., Méserette, V. & te Sligte, E. (2002) Experimental determination of the equivalent circuit of an open side hole: linear and non linear behaviour. Acta Acustica 88, 567–575.
* Dalmont, J.-P., Nederveen, C.J. & Joly, N. (2001) Radiation impedance of tubes with different flanges. JSV 244, 505–534.
* Hirschberg, A., van de Laar, R.W.A., Marrou-Maurières, J.P., Wijnands, A.P.J., Dane, H.J., Kruijswijk, S.G. & Houtsma, A.J.M. (1990) A quasi-stationary model of air flow in the reed channel of single-reed woodwind instruments. Acustica 70.
* Ishizaka, K., French, J.C. & Flanagan, J.L. (1975) Direct determination of vocal tract wall impedance. IEEE TASSP 23.
* Keefe, D.H. (1984) Acoustical wave propagation in cylindrical ducts: transmission line parameter approximations for isothermal and nonisothermal boundary conditions. JASA 75, 58–62.
* Keefe, D.H. (1990) Woodwind air column models. JASA 88, 35–51.
* Lefebvre, A. & Scavone, G.P. (2012) Characterization of woodwind instrument toneholes with the finite element method. JASA 131, 3153.
* Nederveen, C.J. (1998) Acoustical Aspects of Woodwind Instruments, 2nd ed. Northern Illinois UP.
* Norris, A.N. & Sheng, I.C. (1989) Acoustic radiation from a circular pipe with an infinite flange. JSV 135, 85–93.
* Scavone, G.P., Lefebvre, A. & da Silva, A.R. (2008) Measurement of vocal-tract influence during saxophone performance. JASA 123, 2391–2400.
* Silva, F., Guillemain, P., Kergomard, J., Mallaroni, B. & Norris, A.N. (2009) Approximation formulae for the acoustic radiation impedance of a cylindrical pipe. JSV 322, 255–263.
* Story, B.H. (2005) A parametric model of the vocal tract area function for vowel and consonant simulation. JASA 117, 3231.
* van Zon, J., Hirschberg, A., Gilbert, J. & Wijnands, A.P.J. (1990) Flow through the reed channel of a single reed music instrument. J. Physique Colloque C2.

---------------------------------------------------------------------------------------------

## 11. Wave-3 findings: bifurcation, dynamics, embouchure sensitivity, altissimo

**Oscillation onset is an inverse (subcritical) Hopf bifurcation in this model — and that is a property
of the physics, not a bug.** `tools/hb_bifurcation.py` solves the elementary model (quasi-static reed,
Bernoulli characteristic F(x) = (1−x)√x, x = Δp/p_M) by harmonic balance on the TMM impedance and
returns γ = p_mouth/p_M versus the fundamental amplitude. For C5/A4/C#5, γ falls as the amplitude grows
(inverse); removing Z(2ω) makes it direct. The responsible term is the quadratic part of F (F″ ≠ 0 at
x ≈ 1/3) beating with the strong, nearly harmonic 2nd resonance of the cone — the mechanism identified
by Grand, Gilbert & Laloë (1997) and Dalmont, Gilbert & Kergomard (2000) for conical instruments. For
Bb3…G4 the TMM (with reed) has Z2 ≥ Z1, so the octave regime has the lower threshold; the small-amplitude
regime there is the octave (low-note "cracking"). Consequences: an abrupt onset with hysteresis
(onset 2.4–2.6 kPa, extinction 1.2–2.3 kPa) and only ~6–13 dB of level change with blowing pressure at
fixed embouchure. Tested and rejected (no direct bifurcation, or broken locking): smaller vena contracta,
h-dependent vena contracta, viscous cut-off, channel inertia, doubled bore losses, lip force/damping,
tip opening, chamber size (VALIDATION.md §3).

**What should come next for dynamics** (in order): (1) dynamics via embouchure in the player model —
pp = firmer lip (smaller H0 → smaller p_M and ζ), more lip damping; ff = looser — the way players
actually do it, with a fingering-dependent guard where Z2 ≥ Z1; (2) a reed–lip contact model with a
distributed lip mass and amplitude-dependent damping (Chatziioannou & van Walstijn 2012); (3) a
quasi-static flow characteristic measured on a saxophone mouthpiece (Dalmont, Gilbert & Ollivier 2003
style) instead of pure Bernoulli.

**Embouchure pitch sensitivity**: in the model the lip acts on pitch through the reed equivalent volume
(V_r = ρc²S_r²/K ≈ 1.1 cm³ ≈ 15 cents at G4, ≈ 40 cents at C#5) and through the reed resonance/damping.
Lip force 0.6 → 1.4 N changes K by ~20 % → ±5 c (A4) … ±14 c (C#5) … ±25 c (C#6); lip position
12 → 20 mm: −23 … −50 c. Large bends come from the vocal tract (tongue_x with a high tongue: C#5 −55 c,
C#6 −150…−250 c). Low-register lip sensitivity is below what players report; a lip stiffness that
grows with lip force (soft-tissue strain stiffening, making k_lip a larger share of K) is the
physically motivated fix, but it changes p_M, threshold and V_r together and needs a full retune.

**Altissimo (round 4, works)**: the reed sees Z_load = 1/(1/(Z_bore + Z_tract) + Y_reed). With the
default embouchure the reed's compliance/damping (Y_reed, V_r ≈ 1.1 cm³) shunts the ~1 kHz load so much that
no tract resonance can win; with an altissimo embouchure (firm lip → strain-stiffened lip halves V_r,
low lip/reed damping, slightly less mouthpiece), a narrowed glottis (reflective glottal end) and a high
front tongue, G6/G#6/A6 sound from their published fingerings at 4–5 kPa and do not sound with a neutral
tract. Round 5: G6–C7 play within ±21 cents over 4–5 kPa when the fingering's bore resonance lies just
above the target and the tract is tuned slightly above it (pitch anchored to the bore, not the tongue);
C#7/D7 not reachable (tract resonance tops out near 1.35–1.4 kHz with the tip raised). Load analysis:
`tools/altissimo_load.py`. Details, numbers and the tuning tool (`tools/altissimo_tune.py`) in VALIDATION.md §5.

**Flow characteristic and the hard onset**: replacing the Bernoulli characteristic (1−x)√x by plausible
measured-like shapes ((1−x)x^0.3…x^0.7, (1−x)^0.7…1.5 √x) leaves the bifurcation inverse in the harmonic-
balance analysis (C5, A4) — the 2nd-harmonic coupling through Z(2ω) dominates. A measured mouthpiece
characteristic is still worth having, but it is unlikely on its own to make the onset supercritical.

**Round 6 additions.**
* *Dynamics* come from the embouchure, not from blowing pressure alone: with a fixed embouchure the note
  sustains only above ≈ 0.27·p_M and the subcritical onset already gives ≈ 0.3·p_M of amplitude at
  extinction, so pressure spans only 6–12 dB. A player scales the whole oscillation by changing p_M
  (pp: lip force ≈ 2.8–3 N on more mouthpiece, H0 ≈ 0.23 mm, p_M ≈ 2.1 kPa, non-beating, 68–79 dB;
  ff: loose undamped lip at 6–8 kPa, 98–104 dB) — implemented in the player model (assist > 0):
  20.7 dB (register 1) / 22.9 dB (register 2) pp→ff with the centroid rising from ~0.5 to ~1.9 kHz
  (VALIDATION.md §6). Moving the lip toward the tip raises p_M in our reed (wrong direction for pp).
  A pressure-recovery term is equivalent to a larger vena contracta and leaves the onset subcritical.
* *Altissimo*: final voicings use tract peaks of 33–50 MPa·s/m³ (G6–B6) and 16–17 (C7, C#7) — the measured
  range — with fingerings whose bore resonance lies just above the note; all of G6–C#7 sound from 3.5 to
  5 kPa within ±21 cents; D7 is limited by the bore (≤ 8 MPa·s/m³ near 1.4 kHz). The engine and
  `tools/tract_tmm.py` agree on the glottis effect (≈ 2× tract peak at A_g = 0.15 vs 1.61 cm²); a narrowed
  glottis helps but is not required. Subglottal end: anechoic trachea (no subglottal resonances).
* *Attack history*: the previous note's bore oscillation (Q ≈ 52–66, τ = Q/(πf) ≈ 60–150 ms, T60 ≈ 120/f0 s — corrected in M9) and mouth pressure (lung release
  τ = 120 ms) seed the low regime if the altissimo attack follows within ~0.1–0.2 s; the player model's
  "voice, then attack" gate (tongue on the reed until the voicing ramp is complete and ≥ 0.1 s has
  passed; trims reset per attack) makes the attack independent of the previous state.
* *Tract strength vs frequency*: the articulatory model can make 30–90 MPa·s/m³ resonances only at
  0.9–1.4 kHz (front tongue); mid/back tongue positions give ≤ 23 at 550–650 Hz and ≤ 10 at 700–800 Hz,
  which is why low-note overtones in that band do not speak (docs/OVERTONES.md).

**Round 7 (geometry/loss, "geometry final").**
* *Wall losses*: `meta.wall_loss_factor` = 1.3 (§2): Q 41–52, peaks −20 %, thresholds +0.04–0.05 kPa.
* *F#6*: the palm/high-F# holes sat at the very top of the body and the best bore resonance any pad
  combination could reach (TMM search over 3437 configurations, incl. front-F/side-key combinations) was
  862 Hz (−36 ¢); hole chimney/pad-lift changes gave ≤ +12 ¢. The physical fix was a shorter neck
  (air path 0.185 → 0.170 m, body correspondingly longer; neck taper, mouthpiece and flare re-optimised
  for harmonicity), which lets the palm holes sit 15 mm higher: F#6 TMM peak 882 Hz (+4 ¢), engine
  −13 ¢ (was −63 ¢). Neck vent moved 0.090 → 0.085 m (r 1.4 mm) for palm-note locking.
* *D7* (1397 Hz): best bore resonance near the target is 5.9 MPa·s/m³ (palm D+Eb+side E+side C),
  ~10× below the competing low resonances; it lies above the open-tone-hole lattice cutoff region where
  the bore's resonances fade, and the articulatory tract tops out at ≈ 1.43 kHz (tongue body lowered, tip
  raised), i.e. it cannot be tuned "just above" D7 with margin. With the final reed, D7 found no robust
  voicing (best worst-case error 110–148 ¢). This is a combination of bore physics (weak resonances above
  ~1.2–1.4 kHz) and the anatomical tract ceiling; real players' D7 relies on fingerings/tract strengths
  beyond what this bore + tract model provides.
* *Palm-key soft regime — correction.* My earlier figures (−14…−23 dB) came from `engine/examples/dyn.rs`
  (assist 0, default embouchure, 6 kPa crescendo then decrescendo in 0.25 kPa steps of ~0.17 s) and took the
  last step above 100 Pa AC — that is the decaying tail just before extinction, not a sustained regime.
  Re-measured on the final tree: E6 and F#6 hold in register down to 2.75 kPa (ac/p ≈ 0.56–0.58,
  ≈ −2 dB from mf), are dying at 2.5 kPa and silent or in the low register at ≤ 2.25 kPa — in agreement
  with the perf engineer. With the default embouchure there is no palm-key pp regime; pp on palm notes
  needs the embouchure change of the player model (dynamics section).


## 12. Auto player — voicing table (`auto_player` in the geometry JSON, schema v1)

Keys-only mode: the user sets fingering + `dynamic`; the engine sets the player controls from a measured
table (pure physics, player_assist 0), adapts them to the mouthpiece/reed setup, and adds feedback
(engine/src/player.rs). Produced by `tools/auto_player.py` (engine in the loop) → `tools/auto_player.json`
→ `tools/build_geometry.py`.

```
"auto_player": {
  "version": 1,
  "controls": [lip_force, lip_position, lip_damping, tongue_x, tongue_y, tongue_tip, tongue_length,
               jaw_open, glottis_open, lung_pressure (kPa), reed_damping],
  "dynamics": {"pp": {"target_db_re_mf": -20, "slider": 0}, "mf": {.., "slider": 0.5}, "ff": {"target_db_re_mf": 6, "slider": 1}},
  "setup_reference": {tip_opening 1.9, facing_length 22, baffle_height 0.3, chamber_size 0.5, throat_diameter 11,
                      mouthpiece_insertion 10, reed_strength 2.5, reed_model 0, temperature 22},
  "groups": {low: register 1, mid: register 2 below D6, palm: D6–F#6 (f_target > 690 Hz), altissimo: register 3},
  "entries": [{note, register, group, keys, f_target,
               voicing: {pp|mf|ff: {control: value}},             // all 11 controls
               achieved: {pp|mf|ff: {cents, db_re_mf, ok}},        // measured at the reference setup, from rest
               robust: {pp|mf|ff: bool, slur_mf: bool}}],
  "adaptation": {
    "pressure_rule": lung = voicing.lung × p_M(setup; voicing lip) / p_M(reference; voicing lip),
    "pM_reference": 6710 (Pa, default embouchure),
    "lip_trim_cents_per_N": {group: c/N},                         // pitch feedback gain
    "per_param": {setup param: {"lip_force": {group: N per unit}}},  // linear, setup clamped to validity
    "validity": {setup param: [lo, hi]}, "notes": ...}}
```

Entries are matched by exact key set (standard, alternates, altissimo). Between dynamics the controls
are interpolated linearly in the slider (pp 0, mf 0.5, ff 1). `tongue_length` is 0 throughout (it
moved pitch but never made a note more robust).

**Robustness criteria for an entry.** The voicing must sound in register and in tune: ±10 ¢ in
register 1, ±15 ¢ in register 2, ±25 ¢ in altissimo. It must stay in register within tol + 15 ¢ when
any one of these changes: lung ±10 %, lip ±0.15 N, tongue_x ±0.015. A pp voicing must additionally
survive the adaptation rule on reed 2.0/3.5 and tip 1.6/2.5 (it sits near threshold). The mf voicing
is also checked as a slur from the chromatic neighbour.

**Similarity rule for pressure.** The reed oscillation depends on p_lung/p_M. p_M = K·H0/S_r is
therefore the scale that carries a voicing across tip opening, facing and reed strength. p_M must be
evaluated at the voicing's own lip controls. At pp (lip ≈ 3 N, 14–20 mm of mouthpiece) the static
deflection saturates and p_M ≈ 2.1 kPa, so a hard reed raises it ×1.37, against ×1.14 at the default
embouchure. Using the default-embouchure ratio costs 5–8 % success on reed and tip changes.

**What the measured table shows** (2026-10, tree after round 7):
* **mf.** 43 of 44 entries are within ±5 ¢. C#7 is −28 ¢ after the auto-path refit (lip 2.5 N, tongue
  tip 0.9). A firmer lip would raise it (80 ¢/N), but at ≥ 2.8 N the note stops starting reliably.
* **ff.** +4…+8 dB re mf, at 6–9 kPa. The voicing is a loose lip (0.25–0.65 N), little lip damping, an
  open jaw and *less* mouthpiece (8–10 mm). With more mouthpiece at ff the note dies or flips to the
  octave. Altissimo gets only +2…+5 dB.
* **pp.** Robust pp reaches −8…−19 dB in registers 1–2 (median −11.6 dB through the engine's auto path),
  not −20. The voicing is heavy lip (2–3 N),
  more mouthpiece (14–20 mm), lip damping 0.6–1.0, at 1.2–2.4 kPa. The Hopf bifurcation is
  subcritical (§11), so the softest sustained regime still has finite amplitude. Approaching it
  from rest either fails to start or jumps to the octave. Altissimo has no pp at all: −1…−3 dB,
  because threshold ≈ 3.3–3.6 kPa.
* **Tract (register 1–2).** tongue_y, jaw_open and glottis move pitch by ≤ ±5 ¢ and do not change
  the pp level. Tract choices matter only in altissimo, where the hole_table voicings are kept
  ("voice first, then attack").

**Auto-path refit.** In auto mode the engine attacks on the mf voicing and eases to the dynamic over
about 0.3 s. The pp voicings for Bb3, Eb4, E4, E6, F6 and F#6, and C#7 at all three dynamics, were
therefore re-searched through that path: `tools/auto_player_path.py` (render --auto --dynamic), with
robustness required on default/soft/hard reed and on open tip.

**Partial compensation of global detuning.** per_param does not try to compensate setups that detune
the whole instrument (baffle + chamber, temperature, insertion). In register 1 the lip has ±10 ¢ of
authority at most. A partial correction would leave registers 1 and 2 detuned by different amounts,
which is worse than one uniform offset the user fixes with the cork.

**Adaptation results** (12 representative notes × 3 dynamics; `adapt_rows` in tools/auto_player.json):

| setup param | raw voicing works | with p_M scaling (+ lip trim) | validity |
|---|---|---|---|
| tip_opening 1.4 / 1.6 / 2.2 / 2.5 / 2.8 / 3.2 | 31 / 64 / 81 / 33 / 14 / 14 % | 78 / 97 / 97 / 92 / 86 / 67 % | 1.6–2.5 |
| reed_strength 1.5 … 5 | 56–94 % | 94–100 % | 1.5–5 |
| facing_length 16–30 | 100 % | 100 % | 15–30 |
| baffle 0 / 0.6 / 1 | | 94 / 89 / 72 % (in tune) | 0–0.6 |
| chamber 0 / 0.25 / 0.75 / 1 | | 50 / 72 / 67 / 28 % | 0.4–0.6 |
| throat 8 / 14 / 16 mm | | 67 / 86 / 81 % | 10–15 |
| insertion 0 / 5 / 15 / 20 mm | | 42 / 67 / 75 / 39 % | 8–12 |
| temperature 10 / 16 / 28 / 34 °C | | 47 / 89 / 75 / 56 % | 16–26 |
| reed_model 1 (beam) | 61 % | 56 % | not supported |

* Tip opening and reed strength act through p_M. Once pressure is rescaled they need only a small lip
  trim, which the `per_param` slopes provide.
* Baffle, chamber, throat, insertion and temperature are tuning offsets. In register 1 no player
  control has more than about ±10 ¢ of pitch authority before the note breaks: lip trim is 13 ¢/N,
  against 50–80 ¢/N in registers 2–3. So a cork moved ±6 mm (±16–23 ¢) or a high baffle (+12–17 ¢)
  leaves the low notes out of tune while they still sound. A real player retunes these with the cork,
  not the lip, and that is what the validity range expresses.

**Advice a player would recognise:**
* pp: firmer lip, take more mouthpiece, lots of lip contact; blow just above threshold.
* ff: drop the jaw, loosen the lip and take *less* mouthpiece. With a loose lip and a long free reed
  the note collapses.
* Altissimo: voice first, then attack. Keep the throat narrow (glottis ≈ 0.05), the tongue high and
  forward, and a firm lip (2 N).
* Low notes do not lip down. Tune with the cork.
* Open tip or harder reed: blow proportionally harder (× p_M ratio).
