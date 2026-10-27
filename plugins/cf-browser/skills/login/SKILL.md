---
name: login
description: Sign in, complete MFA or solve a human challenge through interactive Cloudflare Live View, then verify and save the session.
---

# Login in the shared browser

Follow the [browse workflow](../browse/SKILL.md). Reuse your task and its login tab; start a task only if one is needed. The everyday profile is already selected. A different profile is relevant only when the user requested a separate account environment.

1. Navigate to the login/challenge page and observe it.
2. Call `human action=handoff`, `scope:identity`, with the tab id and a concrete completion instruction, such as “Sign in, then select Done when your account page appears.” The user enters credentials directly in the interactive viewer. Share the local control-panel link if it did not open automatically.
3. Check `human action=status`. While pending, continue unrelated preparation outside the paused profile or wait; the handoff completion signal replaces repeated “are you done?” questions. General assistance unrelated to identity can use tab scope instead.
4. On return, observe the page. Confirm the expected account/signed-in state. Done alone does not prove successful authentication; `failed` or `ended` needs page evidence before continuation.
5. Check the returned checkpoint result. Retry `advanced profile_save` if storage capture failed; the previous saved state remains intact. Continue the original task or call `task_finish` if login was the whole request.

A session may be revoked by the website later. Reuse the profile first; request another human handoff only when the observed site state needs it.
