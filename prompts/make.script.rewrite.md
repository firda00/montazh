<!-- Second pass of the script writer: the code-level cliché check (src/make/slop.ts) found phrases from the banned list. {{script}} is the JSON, {{problems}} one line per finding. -->
TOPIC: {{topic}}
LANGUAGE: {{language}}
ENDING: {{cta}}

This script trips the banned-phrase check:
{{problems}}

SCRIPT:
{{script}}

Rewrite only what is needed: replace every flagged phrase with plain, specific wording (a fact, a number, a name, a cause), keep the facts, the number of beats and the order. If the hook was flagged as vague, open with the most surprising concrete fact of the script. If an ending was flagged as a call to action, end on the sharpest fact or consequence instead. Keep the same JSON shape. Return the JSON only.
