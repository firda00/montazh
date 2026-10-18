<!-- Second pass of the script writer: the code-level checks found problems — banned phrases (src/make/slop.ts) and/or pacing (src/make/script.ts pacingFindings: narration over budget, long beats, a long hook or one that states its fact late). {{script}} is the JSON, {{problems}} one line per finding, {{words}} the narration word budget. -->
TOPIC: {{topic}}
LANGUAGE: {{language}}
ENDING: {{cta}}
NARRATION BUDGET: at most {{words}} words in all voiceovers together.

This script trips the banned-phrase check and/or the pacing check:
{{problems}}

SCRIPT:
{{script}}

Rewrite only what is needed: replace every flagged phrase with plain, specific wording (a fact, a number, a name, a cause), keep the facts, the number of beats and the order. If the hook was flagged as vague, open with the most surprising concrete fact of the script. If the hook is long or states its fact late, make it one short line that starts with the number or the name. If a narration is flagged as long, cut it to one sentence with the beat's one fact; if the whole narration is over budget, shorten every beat until it fits. If an ending was flagged as a call to action, end on the sharpest fact or consequence instead. Keep the same JSON shape. Return the JSON only.
