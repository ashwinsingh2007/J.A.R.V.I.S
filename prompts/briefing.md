[BRIEFING] The user just started their day. Give them a short spoken morning briefing, like a good butler would.

It is {{NOW}}.

Do this yourself in this turn (an exception to TIER 2), with tool calls in parallel where you can:
1. First say ONE warm greeting sentence for the time of day, with the time, before any tool call. Mention the day if useful.
2. Weather: run `curl -s 'wttr.in/?format=%l:+%C,+%t,+feels+like+%f'`, or use the user's city from memory with WebSearch.
3. If a calendar connector is available, today's meetings. If a Gmail connector is available, how many emails from the last 12 hours need a reply, and from whom. Skip anything you can't reach, silently.
4. Reminders and routines due today: {{TODAY}}
5. Yesterday, in brief (only mention an open loop or something unfinished, not a full recap):
{{YESTERDAY}}
6. If memory shows interests (topics, teams, markets), one headline worth knowing about them (one quick WebSearch).

Then speak the briefing: four to seven short sentences in total, most important first, in your own words. Warm and calm, a touch of wit if it fits. No lists, no sources, no links. End by offering one useful next step.
