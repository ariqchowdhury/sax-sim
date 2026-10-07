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
| `R_nl` | `K ρ / (2 S_e²)`, K ≈ 1, `S_e = min(S_h, 2πbh)` (jet separation at high amplitude) | Dalmont et al. 2002, Atig et al. 2004 |

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

**Subglottal system**: the engine terminates the tract below the glottis with an anechoic
load ρc/S_trachea (S ≈ 2.5 cm²) — accepted: the trachea/bronchial tree is long and lossy enough
that a matched termination is a standard approximation (Story 2005); it removes spurious
subglottal resonances without adding a state.

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
                  1 back/pharyngeal ⇒ x_c = 0.065),  width σ = 0.020 m
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

**Altissimo**: tract peaks of 15–55 MPa·s/m³ are now available near 0.9–1.25 kHz (high front tongue), but
no altissimo fingering in this bore has its target resonance within a factor ~3 of the lower resonances
(`tools/altissimo_search.py`), and the series |Z_b + Z_t| still favours the lower regime. Real
altissimo relies on cross/vented fingerings whose lower resonances are much more damped than our linear,
nearly lossless vents give — that, and reed-resonance assistance, are the open items.

