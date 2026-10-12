<!-- User turn of the shortlist stage. {{speakers}} is empty or " Speakers: S1, S2 (S1 talks the most)."; {{index}} is one line per phrase: "pN mm:ss-mm:ss S1 ru: text". -->
INSTRUCTION: {{instruction}}
The video has {{count}} phrases ({{speech}} of speech).{{speakers}}
Pick up to {{max}} candidate windows for the instruction: moments a short-form editor would cut from — a strong claim, a story with a payoff, a concrete tip, emotion, a product shown. A window is a run of consecutive phrases (from pN to pM inclusive), at most {{max_seconds}} seconds; choose complete thoughts, spread across the whole video unless the instruction says otherwise. Do not pick everything: what you skip will not be seen by the editor.
PHRASES:
{{index}}
