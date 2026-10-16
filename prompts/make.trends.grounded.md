<!-- Prompt for Gemini with the Google Search tool (server mode trends; no agy). The answer is parsed as JSON; source URLs are taken from the grounding citations. -->
Research what is being said about the topic below THIS WEEK, for a short-form video maker. Use Google Search: run 3–5 searches (news, YouTube, Reddit/Telegram discussions, "{{topic}} 2026") and extract:
- facts: concrete, checkable statements with a number, a name or a date, each with the URL of the page you took it from;
- angles: 4–6 ways to frame a 30-second video on this topic that people are reacting to right now;
- hooks: 5 opening lines (≤ 12 words each) in {{language}} that would make a viewer stop scrolling;
- avoid: claims that are disputed or unverified, so the script does not repeat them.

TOPIC: {{topic}}
LANGUAGE OF THE AUDIENCE: {{language}}

Answer with one JSON object only, no prose, exactly this shape:
{"facts": [{"text": "...", "source": "https://..."}], "angles": ["..."], "hooks": ["..."], "avoid": ["..."]}
