<!-- Players pass (src/highlights/people.ts): who threw each shot. {{len}} clip length, {{start}} offset, {{sport}}, {{known}}: people already identified in earlier clips ("P1: чёрная футболка, джинсы"), {{shots}}: one line per shot "S12 03:41.5" (the moment the ball reaches the rim, clip-relative). -->
This clip is {{len}} seconds of an amateur {{sport}} session filmed from a tripod (it starts at {{start}}s of the full video). Several people play; some join later.

People already identified earlier in the video (keep their ids when you see them again; describe only by visible appearance, never guess names):
{{known}}

Shots in this clip — each line is a shot id and the moment the ball reaches the rim (MM:SS.s from the start of THIS clip). The release happened about 0.5–1.5 s earlier:
{{shots}}

1. people: everyone who plays or takes part in this clip. Reuse an id from the list above when it is the same person; give a new id (P<next number>) to someone new. look: their clothing and build in Russian, specific enough to tell them apart (colour of top and trousers, sleeves, headwear, build). first_seen: MM:SS when they first appear in this clip (null if from the start). joined: true when this person was not playing before and starts playing in this clip.
2. shots: for EVERY shot id listed, who threw the ball (person id) and where the shooter stood at the release: x, y = centre of their body as fractions of the frame (0,0 top-left). sure: 0–1. If you cannot tell who threw, give your best guess with a low sure value.
