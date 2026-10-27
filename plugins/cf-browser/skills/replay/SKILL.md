---
name: replay
description: Record browser work and fetch Cloudflare session replay after the shared browser has finished.
---

# Record and replay

Start the browser's first task with `record:true`. An already active shared browser cannot have recording retrofitted; let its tasks and user control finish before starting a recording browser.

Keep the `browser_id` returned by task start. Finish the requested work through the [browse workflow](../browse/SKILL.md), then finish the task. Other agents or the human may still own the browser: recording retrieval waits for confirmed remote closure and never closes their work itself.

Discover `advanced topic=replay`, then call `recording_fetch` with that Cloudflare browser id in its `session_id` argument. The result provides replay HTML, rrweb events and optional network HAR artifacts. Open the replay HTML when the user asks to watch. Treat captured page content as sensitive task data; report artifact paths and counts rather than dumping the recording into chat.
