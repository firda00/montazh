<!-- Second, people-focused pass of event detection (src/understand/events.ts). Same clip, fewer frames; the audio matters most here. {{len}}, {{start}}, {{sport}}, {{mmss_end}} as in events.gemini.user. -->
This clip is {{len}} seconds long and starts at {{start}}s of a longer video of an amateur {{sport}} session filmed from a tripod. Ignore the shots themselves this time.

Log the HUMAN moments a highlights editor would use as story beats, using both the picture and the sound:
- people_approach — someone who was not playing walks up to the players, talks to them, asks to shoot or to join, gets the ball; also players greeting a newcomer
- celebration — cheering, a high five, an emotional reaction
- funny — laughter, a joke, a fail people react to
- other — a clearly audible conversation between the players

Timestamps are MM:SS from the START OF THIS CLIP (00:00–{{mmss_end}}). start: when the person comes into view or starts talking; end: when the exchange is over (keep it under 15 s, pick the most telling part). key: the moment the question / greeting is said. speech: true when words are audible. description: one concrete sentence in Russian (who, what they do / say). quality 0-1: how well this works as a story beat in a short edit. Shots are not needed here: set outcome to none, distance unknown, ball_x/ball_y null. If nothing like this happens, return an empty list.
