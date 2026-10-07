# How Saxophone Altissimo Actually Works

*Compiled 2026-10-06 from the acoustics literature and from building the sax_sim
first-principles simulator. Literature references are cited from memory and were not
re-checked online for this draft; treat details as approximate.*

## Summary

Altissimo works because the player's vocal tract becomes part of the instrument. Above
written F#6 the saxophone's own resonances are too weak to choose the note, so an expert
shapes the throat and tongue into a resonator tuned near the target pitch. That resonator
adds to the bore's resonance at the reed, and together they outvote the stronger low notes.

This article combines the published acoustics research with what we learned building a
first-principles alto saxophone simulator. The simulator plays the normal range well but
does not yet produce altissimo, and the reasons it fails are themselves a useful map of what
a player has to do.

```
 lungs ─► glottis ─► vocal tract ─┐                ┌─► bore + tone holes ─► bell
                     (Z_tract)    └──► REED ◄──────┘     (Z_bore)
                                   feels Z_tract + Z_bore  (in series)

 Normal range:  Z_bore peak dominates      → bore chooses the note
 Altissimo:     Z_bore peaks weak up high  → player tunes Z_tract peak near target,
                                             the sum wins over the lower bore peaks
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

Three things cause this:

1. **The tone-hole lattice stops reflecting.** A row of open tone holes reflects sound like
   the end of the tube only below a cutoff frequency, roughly 1 to 1.5 kHz on an alto.
   Altissimo (sounding about 900 Hz and up) sits at or above that cutoff, so the reflections
   that build tall peaks are leaking out.
2. **Losses grow with frequency.** Friction and heat loss at the bore wall rise with
   frequency, flattening every high peak.
3. **The lower peaks are still there.** Any fingering leaves strong peaks in the 400 to
   600 Hz range. A reed with nothing else helping will fall into one of those.

So blowing harder or biting does not create the note. Something has to raise the impedance
at the target frequency, or knock down the competing lower peaks. Players do both: the vocal
tract does the first and the fingering does the second.

## The vocal tract is a second resonator

The reed sits between two air columns, the mouth and throat behind it and the saxophone in
front, and it feels both of them. The same airflow passes through the reed into both, so
their impedances add (they act in series). Whatever the tract contributes at a frequency is
added to what the bore contributes there.

In ordinary playing the tract's peaks are weak and far from the note, so it barely matters.
Chen, Smith and Wolfe measured saxophonists while they played (Science, 2008). They found
that experts in the altissimo range shaped the tract to give a strong impedance peak near
the note they were playing. Those peaks were comparable in size to the bore's own peaks.
Less experienced players did not do this and could not reach those notes.

What the shaping looks like physically:

- **Tongue high and forward**, as in the vowel "ee". That makes a narrow channel behind the
  teeth and a large cavity behind it, which together resonate in the right range.
- **Fine-tuned by tongue position.** Small moves of the tongue slide the tract resonance up
  and down. In our model a high front tongue tunes the tract peak from 0.45 to 1.25 kHz.
- **The throat is kept open and the glottis mostly closed** during the note, which makes the
  tract a better resonator.
- **Tuned slightly above the target**, so that the combined peak lands on the note.

The same mechanism explains pitch bends. A tract peak near a note pulls the pitch, which is
how players bend notes and play glissandi. In our simulator the tract alone bends
upper-register notes a long way (C#6 by 150 to 250 cents, D6 by 126 cents).

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

This is where our simulator falls short. Its vents behave almost linearly and lose little
energy, so lower peaks survive any fingering. On a real horn, air rushing through a small
open vent loses energy to turbulence, and that loss grows with loudness. That probably damps
the competing lower modes much more than our model does.

## Reed, embouchure and air

The embouchure and air support do not choose the altissimo note, but they set up a reed that
can hold it once the tract and fingering have.

- **Reed resonance.** With the lip on it, an alto reed resonates around 1.5 to 2.5 kHz (our
  model uses 1.9 kHz). Altissimo notes sound from about 0.9 to 1.6 kHz, much closer to that
  resonance than normal notes, so the reed starts to help. A firmer lip raises the reed's
  resonance and its damping.
- **Don't bite.** Biting closes the reed opening and starves the flow. The lip should be
  firm enough to control the reed but not shut it.
- **Lip position.** Taking a little more or less mouthpiece changes how much of the reed
  vibrates. In our model, moving the lip 8 mm along the reed shifted pitch by 23 to 50 cents.
- **Steady pressure, not more pressure.** Notes in our model start near 2.4 kPa and are
  stable at 3 to 4 kPa. Pushing far harder makes the reed slam shut and favours whichever
  peak is strongest, which is usually a lower one.
- **A medium reed is easier than a very soft one.** A soft reed's resonance drops and its
  opening collapses under pressure.

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
5. **First altissimo note: G6 or F#6 from a known chart for your horn.** Set the "ee"
   tongue shape before you blow, start soft but supported, and aim the throat slightly
   above the note. If you hear a lower note, move the tongue rather than blowing harder.
6. **Then slur up into it** from the palm keys, keeping the throat shape continuous. Slurring
   lets the tract stay tuned while the fingering changes.

Signs you are on track: overtones speak cleanly without changing pressure, and altissimo notes
start without a crack once the throat shape is set first.

## What the simulator learned and still can't do

The simulator models the whole chain from first principles: lungs, a 1D vocal tract shaped
by tongue, jaw and glottis, the reed, the mouthpiece, the conical bore and 23 tone holes.
Resonances, pitch and register behaviour of the normal range agree well with a separate
reference model (within about 4 cents for resonances; ±7 cents playing pitch in the low
register).

What it reproduces:

- The tract genuinely bends pitch in the upper register (126 to 250 cents), matching the
  idea that tract resonances pull the note.
- Register selection depends on the balance of competing peaks, as described above.

What it does not reproduce yet:

- **Altissimo.** With a tract tuned to strong peaks (15 to 55 MPa·s/m³), it never sounds
  above about 800 Hz on altissimo fingerings, because the lower bore peaks stay 3 to 5 times
  stronger.
- **Large low-register bends.** Tract bends there are 29 to 55 cents against a target of
  100 or more.

Open questions, which are also where a player's intuition and the physics meet:

- **Nonlinear vent losses.** Turbulent losses at small open holes probably damp the lower
  modes much more than our linear model allows.
- **Reed help near its resonance.** The reed may support altissimo more than our simple
  reed model shows.
- **Tract strength.** Experts may produce even stronger, sharper tract peaks than our tract
  model reaches, through glottis control and very narrow tongue constrictions.

## References

- Chen, J.-M., Smith, J. & Wolfe, J. (2008). Experienced saxophonists learn to tune their
  vocal tracts. *Science* 319, 776.
- Chen, J.-M., Smith, J. & Wolfe, J. (2011). Saxophonists tune vocal tract resonances in
  advanced performance techniques. *Journal of the Acoustical Society of America* 129, 415–426.
- Scavone, G., Lefebvre, A. & da Silva, A. (2008). Measurement of vocal-tract influence
  during saxophone performance. *Journal of the Acoustical Society of America* 123, 2391–2400.
- Fletcher, N. & Rossing, T. (1998). *The Physics of Musical Instruments*, 2nd ed. Springer.
- Nederveen, C. J. (1998). *Acoustical Aspects of Woodwind Instruments*. Northern Illinois
  University Press.
- Dalmont, J.-P., Gilbert, J. & Kergomard, J. (2000). Reed instruments, from small to large
  amplitude periodic oscillations. *Acta Acustica* 86, 671–684.
- sax_sim project: `docs/PHYSICS.md` (model), `docs/VALIDATION.md` (measured tables,
  including the altissimo search).
