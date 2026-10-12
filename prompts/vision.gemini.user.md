<!-- User turn for the Gemini API vision provider. Times are relative to the clip. {{shots}}: "  3: 0-1s" per line; {{transcript}}: "  0.2-2s: text" per line. -->
This clip is {{len}} seconds of a longer video (it starts at {{start}}s of the original; all times below and in your answer are relative to the clip start). Frame is {{width}}x{{height}}; speech language: {{language}}.

The clip is already split into shots by a scene detector. Describe EVERY shot by its index: one scenes[] entry per shot, nothing invented. If a shot is too short or too dark to judge, say so in the description and give a low quality_score.

Shots:
{{shots}}

Transcript (what is said; the clip itself is silent):
{{transcript}}

For each shot also give focus_x/focus_y: where the main speaker's face (or the main product/subject) is, as fractions of the frame, so the clip can be cropped to 9:16 around it. Leave both null when there is no clear subject.

Then list up to 8 highlights: the moments worth a short vertical clip (a strong statement, a visual payoff, emotion, the product shown). Prefer ranges that start and end at sentence boundaries of the transcript. Write reasons in the language of the speech when it is Russian or Uzbek, otherwise in English.
