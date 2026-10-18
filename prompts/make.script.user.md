<!-- User turn of the script writer. {{trends}} is empty or a "TREND NOTES:\n…" block; {{cta}} says whether a call to action is wanted. {{words}}: narration word budget (src/make/script.ts narrationBudget), {{hook_words}} / {{beat_words}}: per-beat caps. -->
TOPIC: {{topic}}
LANGUAGE: {{language}}
TARGET LENGTH: about {{seconds}} seconds ({{beats}} beats; the first is the hook, the last lands the story).
NARRATION BUDGET: at most {{words}} spoken words in all voiceovers together (numbers count as they are said); the hook at most {{hook_words}} words with its number or name in the first five, every other beat at most {{beat_words}}.
AUDIENCE: {{audience}}
ENDING: {{cta}}
{{trends}}
Return the script as JSON only.
