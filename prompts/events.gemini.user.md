<!-- User turn for event detection. {{len}} clip length (s), {{start}} offset of the clip in the original, {{sport}} sport hint from the instruction, {{mmss_end}} last valid timestamp. -->
This clip is {{len}} seconds long and starts at {{start}}s of a longer video. Sport / activity: {{sport}}. The camera is mostly static (tripod); the players and the hoop/goal can be small in the frame.

Log every event worth considering for a highlights edit. Timestamps are MM:SS (tenths allowed, e.g. 03:41.5) from the START OF THIS CLIP, between 00:00 and {{mmss_end}}.

Event types:
- shot_make — a shot that goes in (the ball passes through the hoop / into the goal)
- shot_miss — a shot attempt that does not go in
- dunk_layup — a close-range shot (layup, dunk); set outcome to make / miss
- nice_pass, dribble_move — a skilful pass or move
- celebration — high five, cheering, a reaction after a play
- people_approach — someone new walks up, asks to join or to shoot, a conversation starts
- funny — a fail, a laugh, something unexpected
- other — anything else an editor would want

For each event:
- start: about 1.5 s before the action begins (for a shot: before the release); end: when the outcome is clear (for a shot: about 1 s after the ball reaches the hoop)
- key: the single decisive moment — for a shot the instant the ball reaches the rim / passes through the hoop; for other events the peak moment
- outcome: make | miss | none
- confidence 0-1 that the event (and its outcome) is right; a make you could not clearly see is at most 0.5
- distance: close | mid | long | unknown (how far from the hoop the shot was taken)
- quality 0-1: how good this moment would look in a highlight reel (clean long make, nice move, genuine emotion → high; a scrappy rebound → low)
- ball_x, ball_y: where the hoop/goal the ball is going to sits in the frame at the key moment, fractions 0-1 (0,0 = top-left); null when not visible
- speech: true when people talk audibly during the event (a conversation, someone asking to play)
- description: one short sentence in Russian, concrete (who, what, where), no adjectives you cannot justify

Also give hoop_x, hoop_y: the centre of the rim in the frame (fractions), or null if there is none. List events in time order. Shots are the most important: do not skip attempts, even routine ones — the editor filters later.
