# Overtones on the Saxophone: What Controls Them

*Compiled 2026-10-06 from the acoustics literature and from sweeps of the sax_sim
first-principles simulator; updated after round 7 (see "Update" below). Literature references are cited from memory; treat details as
approximate. Companion to [ALTISSIMO.md](ALTISSIMO.md).*

## Summary

Yes, the simulator reproduces Rascher-style overtones. On low Bb, B, C and C# fingerings, with
nothing changed but voicing, embouchure and air, it plays the fundamental, the low partials,
and scattered high partials up to the 8th or 9th. The low partials (2 and 3, and 4 on low Bb)
are chosen mainly by air pressure and lip firmness, because the saxophone itself offers strong
resonances there. The high partials (sounding above about 850 Hz) need the same voicing as
altissimo: a high, forward tongue, a narrowed throat, a firm lip and more air.

The model has one clear gap: overtones sounding between about 550 and 800 Hz (the 4th and 5th
partials on most of these fingerings) almost never speak. That band is too high for the bore
alone and too low for the model's vocal tract to give strong help. Real players do play these
partials, so this is a limitation of the model, not advice (see the end).

Sigurd Rascher's *Top-Tones for the Saxophone* builds the altissimo register on exactly this
skill: play the overtone series on low fingerings by voicing alone, then carry that control to
altissimo fingerings. The physics explains why that order works.

## What the simulator played

Each fingering was swept over 320 combinations of tongue height and front/back position, tongue
tip, glottis, lip force and blowing pressure, with player assist off. Which partials sounded
(number of settings that produced each):

| Fingering | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Low Bb (139 Hz) | 94 | 12 | 97 | 9 | — | 1 | 1 | 6 | 4 |
| Low B (147 Hz) | 88 | 9 | 106 | — | — | — | 1 | 2 | — |
| Low C (156 Hz) | 87 | 23 | 120 | — | — | 1 | 2 | 3 | — |
| Low C# (165 Hz) | 88 | 10 | 133 | — | 2 | 1 | 1 | 1 | — |

Every fingering also squealed near 2 kHz in 30 to 70 settings (the reed's own resonance, below).
The 4th partial sounded only on low Bb (554 Hz) and the 5th only on low C# (824 Hz): both of
those fall just outside the 550–800 Hz band where the model gets no help.

Detail for low Bb fingered (sounding Db3, 138.6 Hz), from the sweep above plus a second, finer
search of 240 high-voicing settings aimed at the 5th partial. The same pattern held on B, C and C#:

| Partial | Written note (approx.) | Sounding | How often it appeared | What produced it |
|---|---|---|---|---|
| 1 | Bb3 | 139 Hz | common | normal, relaxed lip (1.0 N) |
| 2 | Bb4 | 277 Hz | rare | relaxed lip, open throat, moderate air (3.5 kPa) |
| 3 | F5 | 416 Hz | most common | firmer lip and/or more air; tongue position hardly mattered |
| 4 | Bb5 | 554 Hz | occasional | more air (4.5 kPa), normal lip |
| 5 | D6 | 693 Hz | never | falls in the model's 550–800 Hz gap (see the end) |
| 6–9 | F6 to C7 | 830–1250 Hz | occasional | high, forward tongue; narrowed glottis; firm lip; more air |
| "squeal" | — | 1.9–2.2 kHz | common with a firm lip | firm, lightly damped lip with the tongue low or back |

The squeal is not an overtone of the tube. It is the reed vibrating at its own resonance,
which takes over when the lip is set for high notes but the throat is not tuned to support one.

## Why low and high overtones behave differently

**The saxophone's resonances weaken as you go up the series.** For the low Bb fingering, the
air column's resonance strengths were:

| Resonance | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Frequency (Hz) | 138 | 279 | 418 | 551 | 693 | 844 | 991 | 1136 | 1287 |
| Strength (MPa·s/m³) | 42 | 63 | 62 | 39 | 17 | 7.9 | 4.4 | 2.4 | 1.8 |
| Ratio to resonance 1 | 1.00 | 2.02 | 3.03 | 3.99 | 5.02 | 6.11 | 7.18 | 8.23 | 9.32 |

- **Partials 2 and 3 are the strongest resonances of all.** That is why the fundamental of low
  notes is fragile and why low Bb cracks up so easily: the instrument would rather play them.
  To choose between partials 1 to 4 you mostly change how hard the reed is driven (air
  pressure) and how much it is allowed to swing (lip firmness), not the tongue.
- **From the 6th resonance up, the bore barely helps** (under 8 MPa·s/m³). The tube's
  reflections leak out through the open bell and walls, as they do for altissimo. Here the
  vocal tract has to supply most of the resonance, so the tongue and throat decide the note.
- **The upper resonances drift sharp.** The 8th resonance sits 8.23 times the fundamental
  instead of 8, about 50 cents sharp. Combined with the tract's pull, upper overtones rarely land
  exactly on the fingered note's pitch, so match them by ear rather than assuming they are in
  tune.

**Where the vocal tract can help.** In the model, a high, forward tongue makes a strong tract
resonance (25 to 70 MPa·s/m³) between about 1.0 and 1.3 kHz, which is exactly the region of
partials 7 to 9 on low Bb and of altissimo G6 to C7. Moving the tongue back lowers that
resonance toward 800 Hz, but it also weakens it sharply (to 5 to 12 MPa·s/m³).

## What controls overtones most, in order

1. **Air pressure** selects among the low partials: more air pushes the reed onto a higher
   strong resonance (3rd and 4th).
2. **Lip firmness** works with the air: a relaxed lip favours the fundamental and 2nd; a firm
   lip favours the 3rd and up, and with nothing else tuned it produces the reed squeal.
3. **Tongue height and front/back position** select the high partials (6th and up). High and
   forward gives the strongest support; small front/back moves choose which partial.
4. **Glottis (throat) narrowing** helped the high partials in the model: 10 of the 12 high
   partials on low Bb appeared with a nearly closed glottis. It roughly doubles the tract
   resonance, but it is a help rather than a requirement.

## A practice route that follows the physics

This follows the spirit of Rascher's exercises, ordered by what the physics says each step
trains.

1. **Fundamental, relaxed.** Play low Bb with a relaxed lip and moderate air. This is your
   reference.
2. **2nd and 3rd partials with air and lip only.** Keep the fingering and the tongue still.
   Firm the lip slightly and add air until the note pops to the octave, then the twelfth.
   Release to come back down. If you skip the 2nd and land on the 3rd, use less lip and more air.
3. **Match each overtone to the real note.** Alternate the overtone with the normally fingered
   note (Bb4, F5). Make them sound the same and notice the small differences in throat feel.
4. **4th partial: more air, steady lip.** Bb5 on the low Bb fingering. Support rather than bite.
5. **5th partial and up: switch on voicing.** Raise the tongue as in "ee" (see
   [what that means physically](ALTISSIMO.md#what-high-and-forward-means-for-your-tongue)), keep it forward,
   firm the lip and feel the throat narrow slightly, as if about to whisper. Then slide the
   tongue forward and back in small steps to move between partials. This is the altissimo skill.
6. **If you hear a thin, piercing squeal**, the lip is ready but the tongue is not tuned: move
   it forward and up rather than adding pressure.
7. **Repeat on low B, C and C#**, then carry the same voicing to altissimo fingerings
   (see [ALTISSIMO.md](ALTISSIMO.md)).

## Update: windpipe, tongue shape and a lossier saxophone (round 7)

The tables above come from an earlier version of the model. Round 7 added three things that
change the overtone picture:

- **The windpipe below the vocal folds.** The trachea and bronchi have their own resonances
  (about 550, 1400 and 2300 Hz). With the glottis open they couple into the mouth and add tract
  resonances in exactly the 620–820 Hz region where overtones were missing.
- **A "bunched" tongue.** Arching the tongue along a longer stretch of the palate, rather than
  at a single high point, strengthened the tract resonances at 620–800 Hz from 13–20 to
  23–38 MPa·s/m³. It also made the 2nd partial (the octave without the octave key) much easier.
- **Real-instrument wall losses.** The model saxophone is now about 30 % lossier, as real
  instruments are, which weakens its upper resonances further.

With the first two on the earlier bore, partials 4 and 5 on low Bb–C# went from 6 sounding
settings to 41 (out of 136 high-tongue settings per note). On the final, lossier model they
sound in a narrow window: partial 4 in 18–32 of 960 settings per note (low Bb–B), partial 5 in
1–10.

**What limits the 4th and 5th partials now is the saxophone, not the mouth.** On low C the
air column's 5th resonance sits about 100 cents flat of the true 5th partial and is very weak
(about 3 MPa·s/m³); on low C# it sits about 100 cents sharp. Changing the size of the lowest
tone holes by ±20 % didn't fix it, so it comes from how the open low holes and the bell shape
this bore, not from a single wrong dimension. Real saxophones differ here, which may be why
some players find particular partials on particular low notes much easier than others.

**For players this suggests:**

- For partials 4 and 5, try an open throat (let the windpipe resonances help) together with a
  long, bunched tongue arch, rather than the narrow, held throat used for altissimo.
- Expect these partials to speak only in a narrow window of voicing and air, and to be out of
  tune; match them by ear.
- If one low fingering won't give you its 5th partial, try the neighbouring low note: the
  resonance that helps is a property of the instrument and changes from note to note.

## Trying it in the simulator

1. Set **Player assist to 0**. Otherwise the player model "helps" the low Bb fingering back to
   its fundamental.
2. Use direct-key mode (backtick key) and press the low Bb fingering, or click the keys.
3. Blow with Space, then raise lung pressure or lip force to step up through partials 2 to 4.
4. For higher partials, set lip force about 1.8 N and lip damping 0.2, narrow the glottis, and
   drag the tongue high and forward while watching the impedance plot's tract overlay.

## What the simulator can't do yet

- **Overtones sounding between about 550 and 800 Hz almost never speak.** The bore's resonances
  there are moderate at best (17 MPa·s/m³ for the 5th on low Bb), and the model's vocal tract
  cannot help: within anatomical limits it reaches only 13–23 MPa·s/m³ at 550–650 Hz and at most
  10 at 700–800 Hz, against 30–90 at 0.9–1.4 kHz. Tuning that low needs a mid or back tongue,
  which leaves a large cavity in front, and a large cavity gives a weak resonance. We tried
  narrower and longer constrictions, different glottis and jaw settings, without success. Real
  players do play these partials, perhaps using the tract's second resonance or lip control in
  ways our one-dimensional model doesn't capture.
- **The 2nd partial was rare** on every fingering (9 to 23 of 320 settings), appearing only with a relaxed lip, open throat and
  moderate air; real players find it easy. The model jumps to the 3rd too readily.
- **The glottis helps but is not required.** Narrowing it roughly doubles the vocal tract's
  resonance strength in the model, which is why it featured in most of the high-partial
  settings; altissimo notes in the model also sound with an open glottis once the fingering
  anchors the pitch.

## References

- Rascher, S. (1941; later editions). *Top-Tones for the Saxophone: Four-Octave Range.* Carl Fischer.
- Chen, J.-M., Smith, J. & Wolfe, J. (2008). Experienced saxophonists learn to tune their
  vocal tracts. *Science* 319, 776.
- Chen, J.-M., Smith, J. & Wolfe, J. (2011). Saxophonists tune vocal tract resonances in
  advanced performance techniques. *Journal of the Acoustical Society of America* 129, 415–426.
- Fletcher, N. & Rossing, T. (1998). *The Physics of Musical Instruments*, 2nd ed. Springer.
- sax_sim project: `tools/tmm.py --fingering Bb3` (resonance table above),
  `engine/examples/tractpeak.rs` (tract resonance by tongue position).
