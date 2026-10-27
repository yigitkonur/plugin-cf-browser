# Visual interaction

Use semantic observations for links, fields and buttons; use screenshots directly for canvas, maps, rich editors, layout and visual discrepancies. Choose the representation that answers the current question.

`screenshot` returns an MCP image, `observation_id`, viewport width/height, scroll offsets and an artifact path. Actions use viewport CSS pixels, with origin at the top-left. If `image_size` differs from the viewport dimensions, convert image coordinates: `x * viewport.width / image_size.width` and the equivalent for y. A full-page image is reference material and cannot stand in for a viewport image.

After scrolling, resizing, navigation or human control, take a fresh screenshot before another coordinate action. The manager checks viewport/scroll geometry and observation generation, but animations or DOM updates can still move a target between image and input. Read the post-action state and take another image when the outcome is visual.

For dragging, identify both endpoints on the current viewport. A semantic drag uses two observed targets. A visual drag uses `drag_xy` with the same screenshot's start and end coordinates. If the destination is offscreen, establish the new viewport before attempting the drag.

An element can be present in a semantic tree while obscured on screen. Inspect the image and resolve the overlay or layout state. Guessing coordinates from an unseen screenshot or using coordinates copied from an older viewport undermines the observation loop.
