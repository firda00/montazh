<!-- Hoop localisation on one full-resolution still frame (src/understand/events.ts). -->
This is one frame from a static camera filming a {{sport}} game. Find the basketball hoop (or goal) that players shoot at.
Return the bounding box of the RIM plus the net hanging under it (not the backboard, not the pole), as fractions of the frame (0,0 = top-left): x0, y0, x1, y1. Also give rim_x, rim_y: the centre of the rim ring. If there is no hoop or goal visible, set found to false.
