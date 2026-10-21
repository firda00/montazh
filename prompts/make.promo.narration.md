<!-- Stage 31: narration for a voiced promo (`make --format promo --voice …`). One spoken line per group of scenes; the on-screen words stay as they are. -->
Write the voice-over for this promo / explainer. The film is cut into GROUPS of scenes; for each group write what the narrator says while it is on screen. The viewer reads the on-screen words at the same time, so the narration adds the "why" and the connective tissue in plain spoken {{language}} instead of repeating the cards word for word.

PRODUCT / SUBJECT: {{product}}
GROUPS (seconds available · what is on screen):
{{groups}}

Rules:
- Exactly {{count}} lines, in the same order, one per group.
- Each line fits its seconds at a calm pace: at most the number of words given for it (about 2.4 words a second, minus a breath). Shorter is better than longer.
- Spoken language: no symbols ($, %, «», /, +), no abbreviations; numbers may be digits but units are words («два процента», «двадцать процентов», «десять лет»). Brand and product names keep their usual spelling.
- Facts only from the on-screen material; no new numbers, no hype words, no «давайте разберёмся», «представьте», «в мире, где», no rhetorical questions to the viewer except where the card itself asks one.
- The first line hooks immediately; the last line lands the takeaway (and the call to action only if the card shows one).
Return {"lines": [...]} only.
