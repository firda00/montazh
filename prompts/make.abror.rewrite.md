<!-- Second pass of the Uzbek venture-news writer: the code checks (src/make/abror/script.ts validateAbrorScript, verifyNumbers) found problems. {{problems}} one line per finding, {{script}} the JSON, {{news}} / {{facts}} the same sources as the first pass. -->
TOPIC: {{topic}}
CTA COMMENT WORD: "{{keyword}}"

NEWS (sources):
{{news}}
{{facts}}
The script below fails these checks:
{{problems}}

SCRIPT:
{{script}}

Fix exactly these problems and keep everything else: the template order hook → intro («Bu — …») → 2–4 facts → twist («Eng qizigʻi — …») → 1–2 lesson lines → cta («"{{keyword}}" soʻzini yozib qoldiringlar»); at least two of his phrases («Gap shundaki», «Tasavvur qilinglar», «Yaʼni»); oʻ/gʻ with U+02BB; a number that is not in the sources is replaced by the number the source gives (or the line drops the number). Return the JSON only.
