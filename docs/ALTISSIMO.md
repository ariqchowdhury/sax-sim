# How Saxophone Altissimo Actually Works

*Compiled from the acoustics literature and from building the sax_sim first-principles
simulator. First written 2026-10-06; updated after the simulator reached G6–C7 with fingering-anchored pitch
(round 5). Literature references are cited from memory and were not re-checked online; treat
details as approximate.*

## Summary

Altissimo needs four things at once: a firm, low-damping embouchure, a narrowed glottis, a
vocal tract tuned just above the target note, and a fingering whose own resonance sits
slightly above the note. Above written F#6 the saxophone's own resonances are too weak to
choose the note. An expert shapes the throat and tongue into a resonator tuned near the target
pitch, and that resonator adds to the bore's resonance at the reed. But the tract can only win
if the reed itself stops soaking it up, and the note only stays in tune if the fingering, not
the tongue, sets the pitch.

This article combines the published acoustics research with what we learned building a
first-principles alto saxophone simulator. The simulator now plays written G6 through C7
within about ±20 cents across normal breath pressures with a tuned tract, and falls back to
low notes with a neutral one, which is the effect players describe.

```
 lungs ─► glottis ─► vocal tract ─┐                ┌─► bore + tone holes ─► bell
                     (Z_tract)    └──► REED ◄──────┘     (Z_bore)
                                   feels Z_tract + Z_bore in series,
                                   with the reed's own give (Y_reed) in parallel:

            Z_load = 1 / ( 1/(Z_bore + Z_tract) + Y_reed )

 Normal range:  Z_bore peak dominates          → bore chooses the note
 Altissimo:     Z_bore peaks weak up high      → tune Z_tract near the target,
                firm lip shrinks Y_reed        → the sum can finally beat the low peaks
```

## How a reed instrument picks its note

The reed is a pressure-controlled valve, and it sounds at whichever resonance of the air
column gives it the strongest push back. That push is measured by the acoustic impedance
seen at the reed: how much pressure a given airflow produces at each frequency.

- **Impedance peaks are the playable notes.** For a given fingering, the bore has a series
  of peaks. On a cone like the saxophone they fall roughly at 1, 2, 3, 4… times the lowest one.
- **The strongest peak usually wins.** Blow gently with a normal embouchure and the reed
  locks to the tallest peak it can reach. That is usually the lowest one for low notes.
- **Registers are just different peaks.** The octave key opens a tiny vent that weakens
  peak 1, so peak 2 becomes the strongest and the note jumps an octave.
- **The reed has its own resonance**, around 1.5 to 2.5 kHz when the lip is on it. Close to
  that frequency, the reed itself helps any peak it sits near.

Our simulator measured this directly. For low notes, peak 2 can be as strong as peak 1,
which is why beginners crack up an octave. At 3 to 4 kPa of blowing pressure, low notes jump
up once pressure exceeds about 55% of the pressure that slams the reed shut. High notes drop
down below about 45%. The window for a single embouchure is narrow, and players adjust for
every note without thinking about it.

## Why altissimo is hard

Above written F#6 the bore no longer offers a strong peak at the note you want. In our
simulator, across 1,091 pad combinations, the best bore peak at written G6 or A6 was only
0.2 to 0.3 times as strong as the strongest lower peak.

Four things work against you:

1. **The tone-hole lattice stops reflecting.** A row of open tone holes reflects sound like
   the end of the tube only below a cutoff frequency, roughly 1 to 1.5 kHz on an alto.
   Altissimo (sounding about 900 Hz and up) sits at or above that cutoff, so the reflections
   that build tall peaks are leaking out.
2. **Losses grow with frequency.** Friction and heat loss at the bore wall rise with
   frequency, flattening every high peak.
3. **The lower peaks are still there.** Any fingering leaves strong peaks in the 400 to
   600 Hz range. A reed with nothing else helping will fall into one of those.
4. **A relaxed reed soaks up high-frequency help.** The reed bends under pressure, so it acts
   like a small extra air volume (about 1.1 cm³) plus the damping of the lip. Near 1 kHz, at
   a normal embouchure, that "give" is so large that it shorts out whatever the tract adds.
   In our model it was about 21 MPa·s/m³ of compliance and about 60 MPa·s/m³ of loss in
   parallel with the air columns.

So blowing harder or biting does not create the note. Something has to raise the impedance
at the target frequency, and the reed has to stop absorbing it. Players do both: the tract
does the first and the embouchure does the second.

## The vocal tract is a second resonator

The reed sits between two air columns, the mouth and throat behind it and the saxophone in
front, and it feels both of them. The same airflow passes through the reed into both, so
their impedances add (they act in series). Whatever the tract contributes at a frequency is
added to what the bore contributes there.

In ordinary playing the tract's peaks are weak and far from the note, so it barely matters.
Chen, Smith and Wolfe measured saxophonists while they played (Science, 2008). They found
that experts in the altissimo range shaped the tract to give a strong impedance peak near
the note they were playing. Those peaks were comparable in size to the bore's own peaks
(tens of MPa·s/m³). Less experienced players did not do this and could not reach those notes.

What the shaping looks like physically:

- **Tongue high and forward**, as in the vowel "ee". That makes a narrow channel behind the
  teeth (about 0.1 cm² in our model) and a larger cavity behind it, which together resonate
  between about 0.9 and 1.2 kHz.
- **Small jaw opening**, which keeps that front channel narrow.
- **Fine-tuned by tongue position.** Small forward/back moves of the tongue slide the tract
  resonance up and down. In our model a high front tongue tunes the tract peak from 0.45 to
  1.25 kHz, and the best settings for G6, G#6 and A6 differed by only a few percent of the
  tongue's travel.
- **A narrowed glottis.** This turned out to matter. With the vocal folds nearly closed
  (about 0.15 cm² open in our model), the bottom of the tract reflects sound instead of
  leaking it into the lungs. That raised the tract peak near 1 kHz from about 55 to about
  85 MPa·s/m³, the size Chen, Smith and Wolfe measured on experts.
- **Tuned above the target**, so that the combined peak lands on the note. In our model the
  tract resonance sat well above the note, for G#6 about 1.2 kHz against a 988 Hz note
  (roughly a minor third higher). The sharp fingering then pulls the combined peak down onto
  the note.
- **Higher notes need a smaller front cavity.** From B6 up, our model needed the tongue body
  a little lower with the tip raised, which shrinks the space behind the teeth and pushes the
  resonance to 1.1–1.3 kHz. Above about C7 our model tract could not be tuned high enough, so
  C#7 and D7 did not sound. Real players who reach those notes may use tract shapes beyond our
  simple tongue model.

The same mechanism explains pitch bends. A tract peak near a note pulls the pitch, which is
how players bend notes and play glissandi. In our simulator the tract alone bends
upper-register notes a long way (C#6 by 145 to 250 cents) and C#5 by about 50 cents.

## What altissimo fingerings do

An altissimo fingering does two jobs: it puts a usable bore peak near the target, and it
damps the lower peaks that would otherwise win. Most altissimo fingerings are
cross-fingerings: a closed hole with open holes below it, plus extra vents such as the palm
or side keys.

- **Opening holes in odd places breaks up the lower modes.** A hole opened near the point
  where a lower mode's pressure is highest drains that mode, much as the octave vent drains
  peak 1.
- **The useful peak is often a high harmonic.** Many altissimo notes sit on the 3rd to 6th
  resonance of a cross-fingered column rather than on a clean low mode.
- **Fingerings are instrument-specific.** Small differences in tone-hole size and position
  change which peaks survive, which is why altissimo charts differ between alto models and
  why players collect alternates.

**Pick fingerings that are slightly sharp on their own.** This was the key to accuracy in
our model. When the fingering's bore resonance sits 0 to +20 cents above the target and the
tract is tuned a little above that, the note locks 0–20 cents below the bore peak, and the
fingering sets the pitch. The tongue then only needs to be inside a window rather than at an
exact spot: on G#6, moving the tongue across its window shifted pitch only −16 to +11 cents.
With fingerings whose resonance sat below the note, pitch followed the tongue instead and
drifted by ±60 cents with breath pressure.

This also explains a practical rule players know: if one altissimo fingering is unstable on
your horn, try alternates until you find one that sits slightly sharp, then voice it down.

**Which fingerings.** We started from common chart fingerings, then let an engine-in-the-loop
search choose fingerings for our model's bore. Some of the winners are not standard chart
fingerings, so treat them as examples of the principle, not a chart for your instrument:

| Note | Fingering used in the model |
|---|---|
| G6 | octave key + LH1 + LH3 + G# |
| G#6 | octave key + LH1 + side C + RH1 + RH3 |
| A6 | octave key + LH1 + LH2 + LH3 + side C |
| Bb6 | octave key + G# |
| B6 | octave key + palm D + side C + RH3 |
| C7 | octave key + palm Eb + side C + RH3 |

The chart patterns (for example G6 = octave + front F + LH1 + LH3) also sounded, but less
robustly in this bore.

We expected turbulent energy loss at small open vents to be the key to damping the lower
modes. It wasn't, for altissimo: adding a realistic, amplitude-dependent vent loss changed
the competing low notes by less than 1 dB. That loss turned out to matter a great deal for
something else: without it, the ordinary upper register (F#5–G#5, E6–F#6) slips down to the
low register far more often (22 failures in 99 tests instead of 5).

## Reed, embouchure and air

In our simulator the embouchure was the decisive factor. With a normal embouchure, no tract
setting could produce altissimo; with an altissimo embouchure plus a tuned tract, it sounded.

- **A firm lip that stiffens the reed.** Lip tissue gets stiffer the harder it is
  compressed. A firm lip roughly halves how much the reed gives under pressure, which stops
  it from soaking up the tract's help near 1 kHz. Our altissimo setting used 1.8 N of lip
  force against a normal 1.0 N.
- **Low damping.** A lip that grips firmly without smothering the reed (low lip damping) and
  a lively reed let the high resonance through.
- **A little less mouthpiece.** Our altissimo setting placed the lip about 11 mm from the
  reed tip against 12 mm normally, which shortens the vibrating part of the reed.
- **Firm is not biting.** Biting closes the reed opening and starves the flow. In our model
  even 3 N of lip force left about 0.2 mm open, but the note quality suffers well before that.
- **Support, not force.** Normal notes are stable at 3 to 4 kPa. In our model G#6, Bb6 and
  C7 start at 3.5 kPa (mezzo-forte), while G6, A6 and B6 need about 4 kPa. Once the voicing
  and fingering are right, the pitch moves at most about 25 cents between 4 and 5 kPa.
- **Watch for squeaks.** With the low-damping embouchure but a neutral tract, our model
  squealed near 2.2 kHz, the reed's own resonance. That is the familiar altissimo squeak: the
  embouchure is ready but the tract is not tuned.

## A practice route that follows the physics

Each exercise trains one piece of the mechanism above, in the order you need them.

1. **Overtones on low Bb.** Finger low Bb and, without touching keys, sound the 2nd, 3rd,
   4th and 5th resonances using only tongue and throat. The bore peaks exist here, so this
   teaches you to tune the tract onto a chosen peak. It is the core altissimo skill in a
   safe range.
2. **Match overtones to real notes.** Alternate an overtone (say the 4th over low Bb, which
   is written Bb5) with the normal fingering of the same note. Make the sound and the feel
   of the throat match. You are learning where your tongue sits for each pitch.
3. **Bend down, then hold.** On palm-key notes (D6 to F6), bend the pitch down a quarter to
   a half tone with the tongue alone and bring it back. The tract has strong control there,
   so you can feel the resonance move.
4. **Mouthpiece and neck pitch.** Play on the neck alone and slide the pitch around with the
   tongue. With no bore peaks to lean on, all the control comes from the tract.
5. **Set the embouchure.** Before the first altissimo attempt, firm the lower lip (without
   biting or pinching the reed shut) and take very slightly less mouthpiece. Expect to need
   more air support than for palm-key notes.
6. **First altissimo note: G6 from a known chart for your horn.** Set the "ee"
   tongue shape and a narrow, "held" throat before you blow, start supported, and aim the
   throat slightly above the note. If you hear a lower note, move the tongue rather than
   blowing harder. If you hear a thin squeak far above the note, the embouchure is ready but
   the tongue is off: slide it forward or back.
7. **Find the window, then stop chasing it.** Once a note speaks, move the tongue slowly
   until it flips out in each direction. The middle of that range is your setting. Inside it,
   the fingering holds the pitch; adjusting the tongue further only risks the flip.
8. **Choose the fingering by its tuning.** If a note is unstable or flat, try alternates and
   keep the one that is slightly sharp before voicing; voicing will bring it down.
9. **Then slur up into it** from the palm keys, keeping the throat shape continuous. Slurring
   lets the tract stay tuned while the fingering changes. In our model, slurs from F#6 into
   every altissimo note locked directly once the voicing was set.
10. **Higher notes: smaller front cavity.** For B6 and C7, keep the tongue tip up behind the
    teeth and let the body drop slightly.

Signs you are on track: overtones speak cleanly without changing pressure, and altissimo notes
start without a crack once the throat shape is set first.

## What the simulator learned and still can't do

The simulator models the whole chain from first principles: lungs, a glottis, a 1D vocal tract
shaped by tongue and jaw, a lower lip made of stiffening tissue, the reed, the mouthpiece, the
conical bore and 23 tone holes with amplitude-dependent losses. Resonances, pitch and register
behaviour of the normal range agree well with a separate reference model.

Altissimo results in pure physics (no player assistance), cents from equal temperament:

| Note | 3.5 kPa | 4.0 kPa | 4.5 kPa | 5.0 kPa | Neutral tract |
|---|---|---|---|---|---|
| G6 | low note | −9 | +2 | +8 | low note |
| G#6 | −10 | +1 | +8 | +13 | low note |
| A6 | low note | −10 | −4 | 0 | low note |
| Bb6 | −6 | +5 | +11 | +15 | low note |
| B6 | low note | −21 | −6 | +3 | low note |
| C7 | −13 | −3 | +1 | +4 | low note |
| C#7, D7 | not reachable | | | | |

"Low note" means the fingering's ordinary bore regime (300–730 Hz). With the low-damping
embouchure but a neutral tract, some fingerings squeal near 2.2 kHz instead.

What turned out to matter, in order:

1. **Altissimo embouchure (decisive).** A firm, strain-stiffened lip halves the reed's
   compliance; less mouthpiece and low lip and reed damping help further. Without it no tract
   setting worked.
2. **A reflective glottal end.** A narrowed glottis lifts the tract peak near 1 kHz to
   70–135 MPa·s/m³. Opening the glottis (40–65 MPa·s/m³) stopped every altissimo note.
3. **Tract tuning** just above the note, with a high tongue and a narrow front channel.
4. **A slightly sharp fingering.** Bore peaks at altissimo frequencies are only 8–18
   MPa·s/m³, but a peak 0–20 cents above the note is enough to anchor the pitch once the tract
   does the heavy lifting. This turned a tongue-controlled ±60-cent drift into ±20 cents.
5. **Vent losses: not important for altissimo**, but essential for a stable ordinary upper
   register.

With the player model's assistance (which sets the voicing automatically when an altissimo
fingering is pressed), every note from G6 to C7 locks from rest and slurs directly up from F#6.

Still open:

- **Our tract may be too strong.** Its resonance peaks (70–135 MPa·s/m³) are above the
  "tens of MPa·s/m³" measured on most players. Weakening them stops altissimo in the model,
  which suggests the remaining gap is on the reed and lip side: real reeds may absorb less
  near 1 kHz than ours.
- **C#7 and D7** need a tract resonance higher than our tongue model can make.
- **G6, A6 and B6** still need about 4 kPa to start.
- **Attack and history matter.** Which note locks depends on how the note starts and on what
  was played just before. A held low note followed by an altissimo attack sometimes locked
  into the low regime; a second attack worked. Once a regime is locked it also tends to hold
  even if the tongue moves. Players know both effects: prepare the voicing before the attack,
  and re-attack rather than trying to "pull" a wrong note up.
- **The beam reed model** (a more detailed reed) did not produce altissimo, because its lip
  model nearly closes the reed under a firm lip. A better-calibrated distributed lip might
  change the picture.

## References

- Chen, J.-M., Smith, J. & Wolfe, J. (2008). Experienced saxophonists learn to tune their
  vocal tracts. *Science* 319, 776.
- Chen, J.-M., Smith, J. & Wolfe, J. (2011). Saxophonists tune vocal tract resonances in
  advanced performance techniques. *Journal of the Acoustical Society of America* 129, 415–426.
- Scavone, G., Lefebvre, A. & da Silva, A. (2008). Measurement of vocal-tract influence
  during saxophone performance. *Journal of the Acoustical Society of America* 123, 2391–2400.
- Dalmont, J.-P., Nederveen, C. J., Dubos, V., Ollivier, S., Méserette, V. & te Sligte, E.
  (2002). Experimental determination of the equivalent circuit of an open side hole: linear
  and non-linear behaviour. *Acta Acustica united with Acustica* 88, 567–575.
- Fletcher, N. & Rossing, T. (1998). *The Physics of Musical Instruments*, 2nd ed. Springer.
- Nederveen, C. J. (1998). *Acoustical Aspects of Woodwind Instruments*. Northern Illinois
  University Press.
- Dalmont, J.-P., Gilbert, J. & Kergomard, J. (2000). Reed instruments, from small to large
  amplitude periodic oscillations. *Acta Acustica* 86, 671–684.
- sax_sim project: `docs/PHYSICS.md` (model), `docs/VALIDATION.md` §7 (altissimo results),
  `tools/altissimo_tune.py` (fingering and tract search), `tools/altissimo_load.py` (load analysis).
