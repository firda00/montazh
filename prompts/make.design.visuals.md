<!-- Stage 26: the visual options the resolver found and verified for each beat, appended to the director's user turn. {{options}}: one line per beat "N: id = label · id = label …". -->

VISUAL OPTIONS (already found and checked; ids for scenes[].shots):
{{options}}

How to use them:
- These are the pictures that show what the narrator NAMES: a real photo of the company / place / person (licensed, checked by a vision model), its brand mark or a typeset wordmark, the product UI drawn in code (terminal, chat, ticker board, funding card, chart), number cards. The video must show the thing being talked about: when the narrator says "Nasdaq", the viewer sees Nasdaq, not a generic stock exchange.
- For every beat that has options, choose a media layout (media_full, media_split, media_number, media_card) and list 1–4 option ids in scenes[].shots, in the order they should appear. The code cuts to each one at the moment the narrator says its entity or number (sub-shots every ~1.5–2.5 s), so pick options of different kinds for variety: e.g. a photo, then the mark with the number, then the product UI.
- Prefer real photos; then brand marks / UI; number cards for the beat's key number. A beat whose fact is a number may still use hero_number / compare: the code inserts the beat's photos and marks before or after that typographic frame.
- Only use ids of the same beat. Leave image null for a beat whose shots cover it; give image a generic query only for a beat with no options.
- Never ask for a generated image of a real person or a brand.
