# The psychology of user interfaces

An interface feels clear when people can see its structure at a glance, quick when it answers within a few hundred milliseconds, and satisfying when it shows them their progress and lets them recover from mistakes. Most of the research below says the same few things. Show grouping with space and edges, not with extra words. Keep the number of choices and the amount to remember small. Make targets large and give every action a path that works with a single plain click. Respond at once, and use motion only to explain a change. Let people undo instead of asking them to confirm. Do not carry meaning in colour alone. Each section gives the idea, the practice, and the pages I opened to check it.

## Gestalt grouping: proximity, common region, similarity, connectedness

**What it is.** People group things by how they look together before they read any of them. Items that sit close together read as related, items inside one bounded area read as a group, items that look alike read as having the same role, and items joined by a line or frame read as linked. Proximity can even override colour or shape as a cue.

**What to do.**
- Use spacing as the first tool: less space inside a group than between groups.
- Put a border or a shared background around a cluster (common region, enclosure) when spacing alone is not enough.
- Make items that do the same job look the same (colour, shape, size), and make different jobs look different.
- Use lines, frames or arrows when a relationship must be explicit (connectedness).
- Recheck groupings at small widths: a responsive layout can break the gaps that made the groups.
- Figure and ground: keep the thing the user acts on clearly in front of its background (stronger contrast, a surface or shadow). No source could be opened for this point, so treat it as general practice.

**Sources.** [Law of Proximity](https://lawsofux.com/law-of-proximity/), [Law of Common Region](https://lawsofux.com/law-of-common-region/), [Law of Similarity](https://lawsofux.com/law-of-similarity/), [Law of Uniform Connectedness](https://lawsofux.com/law-of-uniform-connectedness/), [NN/g on proximity](https://www.nngroup.com/articles/gestalt-proximity/).

## Visual hierarchy and scanning

**What it is.** Visual hierarchy is the arrangement of elements so the eye moves through them in the order of their importance. People rarely read; they scan. Eyetracking found an F-shaped pattern when a page has no structure: a sweep across the top, a shorter sweep lower down, then a scan down the left edge. The layer-cake pattern, where people read the headings and then dive into the section they need, is the most effective scanning pattern short of full reading.

**What to do.**
- Use few levels: about three sizes, with the most important element the largest.
- Use contrast in value and weight to show importance, and limit the number of colours and styles.
- Start rows, headings and bullets with the meaningful word, because the left edge gets the attention.
- Give content clear sections with real headings so scanners can use the layer-cake pattern.
- Squint test: blur the page. What still stands out is your real hierarchy.

**Sources.** [NN/g, visual hierarchy](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/), [NN/g, F-shaped pattern](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content-discovered/), [NN/g, text scanning patterns](https://www.nngroup.com/articles/text-scanning-patterns-eyetracking/).

## Contrast

**What it is.** Text and interface parts need enough luminance difference from their background to be seen by people with moderately low vision or reduced contrast perception. WCAG 1.4.3 requires 4.5:1 for normal text and 3:1 for large text (18 pt, or 14 pt bold). WCAG 1.4.11 requires 3:1 against adjacent colours for the visual information that identifies controls and their states, and for graphics needed to understand content. The ratios are strict thresholds and are not rounded.

**What to do.**
- Check text, icons, input borders, focus rings and selected states, not only body text.
- Check every theme (light, dark, high contrast), not just the default.
- Do not rely on a faint hover or a faint border to show that something is interactive.
- Disabled controls are exempt from the rule, but keep them readable enough to tell what they are.

**Sources.** [WCAG 1.4.3 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [WCAG 1.4.11 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

## Fitts's law and target size

**What it is.** The time to reach a target depends on its distance and its size. Small or far targets take longer and cause more errors, and fast movement towards small targets is the worst case. For a pointer user with limited fine control, this is the difference between a control that works and one that is a daily cost. WCAG 2.5.8 sets a floor of 24 by 24 CSS pixels, or enough spacing that a 24 px circle centred on each undersized target overlaps no other target. Its stated aim is to help people with dexterity limitations or tremors avoid hitting a neighbour.

**What to do.**
- Treat 24 px as the legal floor, not the goal. Aim for around 44 px for frequent actions.
- Make the whole row or card clickable where that is safe, and not just a small icon.
- Leave space between targets, and keep destructive controls away from common ones.
- Put controls near where the eye and pointer already are, such as inline on the row.

**Sources.** [Fitts's Law](https://lawsofux.com/fittss-law/), [WCAG 2.5.8 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

## Hick's law and choice overload

**What it is.** Decision time grows with the number and complexity of choices. Showing everything at once makes every decision slower.

**What to do.**
- Show the few actions most people need, and put the rest behind a menu or a detail view.
- Break a long task into steps.
- Highlight a recommended option or default.
- Do not simplify so far that meaning is lost: a hidden action that people need is worse than a visible one.

**Sources.** [Hick's Law](https://lawsofux.com/hicks-law/).

## Chunking and cognitive load

**What it is.** Cognitive load is the mental effort needed to understand and use an interface. Miller's law says people hold only a handful of items in working memory (the oft-quoted "seven plus or minus two"), and that designers should not treat that number as a hard rule but should break content into smaller chunks. Extraneous load is effort spent on distracting or unneeded design elements; it should be cut first.

**What to do.**
- Group related items into labelled chunks, and keep each chunk short.
- Make options visible so people recognise them instead of recalling them.
- Remove anything that does not help the current task. Extra information competes with what matters.
- Keep names, positions and icons consistent so nothing has to be relearned.

**Sources.** [Miller's Law](https://lawsofux.com/millers-law/), [Cognitive Load](https://lawsofux.com/cognitive-load/), [NN/g, ten usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/).

## Response time and the Doherty threshold

**What it is.** Jakob Nielsen's three limits: 0.1 second feels instant and gives the sense of direct manipulation; 1 second keeps the flow of thought but is noticed; 10 seconds is the limit of attention. The Doherty threshold, from a 1982 IBM paper by Doherty and Thadani, puts the target for productive interaction at under 400 ms, so neither person nor computer waits on the other.

**What to do.**
- Reflect a click, tick or keypress on screen within about 100 ms, even if the server takes longer.
- Aim for under 400 ms for the whole round trip on common actions.
- Show a busy cue after about a second, and a progress bar with a percentage for anything over about 10 seconds.
- Let long operations be cancelled.

**Sources.** [Doherty Threshold](https://lawsofux.com/doherty-threshold/), [NN/g, response times](https://www.nngroup.com/articles/response-times-3-important-limits/).

## Perceived performance: optimistic updates and skeleton screens

**What it is.** How fast something feels matters as much as how fast it is. Skeleton screens are wireframe-like placeholders that hint at the layout while a page loads, and can make a wait feel shorter. An optimistic update shows the result of an action at once and fixes it up if the server later refuses it. No source could be opened for optimistic updates, so that part is general practice.

**What to do.**
- Use skeletons for full-page loads of one to ten seconds; skip them under a second; use a spinner for a single module and a progress bar over ten seconds.
- Never show a bare frame (header and footer only) as a skeleton: it looks broken.
- Show that the first click was accepted. Do not print "don't click twice".
- With optimistic updates, roll back visibly and say why if the server rejects the change.
- A skeleton does not replace real optimisation.

**Sources.** [NN/g, skeleton screens](https://www.nngroup.com/articles/skeleton-screens/), [NN/g, progress indicators](https://www.nngroup.com/articles/progress-indicators/).

## Feedback and micro-interactions

**What it is.** A micro-interaction is a small, single-purpose moment in which a trigger (a user action or a system change) gets a narrow, local response. It shows system status, can help prevent errors, and should be brief and subtle so it informs without pulling attention from the task. The "juice" tradition in game design adds small effects (a bounce, a flash) to make actions feel good; No primary source was opened for it, so it stands here only as the same idea at a larger scale. The aesthetic-usability effect is a related caution: attractive interfaces are forgiven small faults, but not large ones.

**What to do.**
- Answer every action near where it happened, in the same place the pointer is.
- Make the response proportionate: a tick for a small action, more for a rare milestone.
- Keep effects short and never block the next action while they play.
- Pair effects with a lasting state change, so the result is still visible after the effect ends.

**Sources.** [NN/g, microinteractions](https://www.nngroup.com/articles/microinteractions/), [NN/g, aesthetic-usability effect](https://www.nngroup.com/articles/aesthetic-usability-effect/), [NN/g, ten usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/).

## Direct manipulation and drag and drop

**What it is.** Dragging works when it is discoverable and every stage gives clear feedback. NN/g's guidance: signal that an item can be grabbed (a handle, a cursor change), make the grabbed item look lifted, animate the other items out of the way to preview the drop, and start the reshuffle when the dragged item's centre crosses another item's edge. Drop zones can be slightly larger than they look. WCAG 2.5.7 requires that anything done by dragging can also be done with a single pointer without dragging, because people using head pointers, eye gaze or trackballs cannot drag precisely.

**What to do.**
- Lift: give the picked-up item a shadow or slight scale and a clear grab cursor.
- Gap: open a visible placeholder gap where it will land, and move neighbours aside.
- Settle: on drop, ease the item into place and keep it identifiable for a moment.
- Always offer a non-drag path: move up and down buttons, a "move to" menu, and a keyboard way to grab and move, announced to screen readers.
- Make the handle large enough and do not rely on hover to show it.
- Use drag only where users expect it and nothing simpler works.

**Sources.** [NN/g, drag and drop](https://www.nngroup.com/articles/drag-drop/), [WCAG 2.5.7 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

## Motion with purpose, and reduced motion

**What it is.** Motion is good when it explains a change: where something went, what is related, what just happened. Decorative motion costs attention, and for some people with vestibular disorders, non-essential movement causes dizziness, headaches or nausea. WCAG 2.3.3 (level AAA) asks that interaction-triggered motion can be turned off, and 2.2.2 requires a way to pause, stop or hide movement that starts automatically and lasts over five seconds. Browsers expose the operating system setting as `prefers-reduced-motion`, and MDN advises replacing large movements with gentler ones such as fades.

**What to do.**
- Animate only to show a change of state or place.
- Honour `prefers-reduced-motion: reduce`: swap travel, scale and parallax for a fade or an instant change.
- Make sure nothing depends on seeing the animation: the end state must carry the information.
- Avoid looping or auto-starting animation.
- Keep durations short, so the animation never makes the user wait.

**Sources.** [WCAG 2.3.3 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html), [WCAG 2.2.2 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html), [MDN, prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion).

## Progress: the goal-gradient and Zeigarnik effects

**What it is.** The goal-gradient effect is that effort rises as a goal gets closer. Kivetz, Urminsky and Zheng (2006) showed it in a cafe loyalty card study: customers whose card began with free "bonus" stamps bought faster than those with a plain card, and faster acceleration predicted better retention. The Zeigarnik effect is that unfinished or interrupted tasks are remembered better than finished ones. A related caution from the same research summary: activity can drop right after the goal is reached.

**What to do.**
- Show visible progress (a count, a bar, "3 of 5") on anything with steps.
- Start people with a head start where it is honest, such as pre-filled steps.
- Use the pull of unfinished work gently: a visible "what is left" list, not nagging.
- Do not invent progress that is false.

**Sources.** [Goal-Gradient Effect](https://lawsofux.com/goal-gradient-effect/), [Zeigarnik Effect](https://lawsofux.com/zeigarnik-effect/), [Kivetz, Urminsky, Zheng abstract (EconPapers)](https://econpapers.repec.org/RePEc:feb:natura:00658).

## The peak-end rule

**What it is.** People judge an experience mainly by its most intense moment and by its end, not by an average of all moments. Negative moments are remembered more vividly than positive ones.

**What to do.**
- Make the end of a flow (finishing a task, clearing a list) a clear, calm, pleasant moment.
- Put extra care into the moments of highest value or highest frustration, such as errors and empty states.
- Do not end a flow on a prompt, a warning or an upsell.

**Sources.** [Peak-End Rule](https://lawsofux.com/peak-end-rule/).

## Error prevention, and undo over confirmation

**What it is.** Good design removes error-prone conditions or asks for confirmation before consequential actions, and gives clear exits plus undo and redo. Aza Raskin's argument is that confirmation dialogs fail because people form habits and click OK reflexively, so a louder warning does not help. His rule: never use a warning when you mean undo. Let people act freely and reverse the mistake, as Gmail does with deleted mail.

**What to do.**
- Make common actions reversible with an undo that stays on screen long enough to reach with a pointer.
- Keep confirmation for actions that truly cannot be undone, and name the consequence in the button ("Delete 12 tasks").
- Prevent errors at the source: disable impossible choices and say why, and validate as people type.
- Never put a destructive control next to a frequent one.

**Sources.** [A List Apart, Never Use a Warning When You Mean Undo](https://alistapart.com/article/neveruseawarning/), [NN/g, ten usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/), [NN/g, microinteractions](https://www.nngroup.com/articles/microinteractions/).

## What to avoid

- **Clutter.** Extra information competes with what matters (minimalist design heuristic), and extraneous load slows everyone down.
- **Gratuitous motion.** It costs attention and can make some people ill. Honour the reduced motion setting.
- **Colour as the only signal.** WCAG 1.4.1 requires another cue, such as text, shape or pattern, alongside colour.
- **Hover-only or drag-only actions.** Neither works for many pointer setups, and drag-only fails WCAG 2.5.7.
- **Tiny targets packed together.** See Fitts's law above.
- **Reflexive confirmation dialogs** where undo would do.
- **Skeletons that are only a frame**, and bare "Loading..." text.

**Sources.** [WCAG 1.4.1 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html), plus the pages cited above.

## Applying it to a task tracker

**List grouped by due date.**
- Use group headings ("Overdue", "Today", "This week", "Later") as the layer-cake: people read the headings and dive into one.
- Use space between groups and less within them (proximity). Add a count to each heading.
- Start each row with the task title, since the left edge gets the attention. Put the due date and project in a consistent column.
- Mark "Overdue" with text and an icon as well as colour, and check its contrast in every theme.
- Limit what each row shows. Put the rest in a detail panel (Hick, cognitive load).
- Make the whole row open the task, and keep the checkbox a large target apart from the title.

**Board of cards.**
- Each column is a common region; each card is a smaller one inside it. Give cards a surface that stands out from the column background.
- Keep card content to a title and one or two cues. Show a column count.
- Every card needs a "Move to..." menu and keyboard move, not only dragging.

**Drag to reorder.**
- Show a visible handle, lift the row on pick up, open a gap where it will land, and ease it into place on drop. Under reduced motion, drop the travel and just change the order.
- Add move up and move down buttons for single-click reordering, and say the new position to screen readers.
- Make the drop undoable.

**Completing tasks.**
- Respond to the tick within 100 ms, optimistically, and sync after. Roll back visibly if the save fails.
- Do not ask "Are you sure?" to complete; offer a short "Undo" instead, long enough to reach.
- Let the task leave the list with a short fade or an instant change (reduced motion), never a long animation that blocks the next click.
- Show progress: "4 of 9 done today", and a calm, clear state when the list is empty (peak-end).
- Keep any celebratory effect small and rare, and make it optional.

## Sources

- [Laws of UX: Fitts's Law](https://lawsofux.com/fittss-law/)
- [Laws of UX: Hick's Law](https://lawsofux.com/hicks-law/)
- [Laws of UX: Doherty Threshold](https://lawsofux.com/doherty-threshold/)
- [Laws of UX: Law of Proximity](https://lawsofux.com/law-of-proximity/)
- [Laws of UX: Law of Common Region](https://lawsofux.com/law-of-common-region/)
- [Laws of UX: Law of Similarity](https://lawsofux.com/law-of-similarity/)
- [Laws of UX: Law of Uniform Connectedness](https://lawsofux.com/law-of-uniform-connectedness/)
- [Laws of UX: Miller's Law](https://lawsofux.com/millers-law/)
- [Laws of UX: Cognitive Load](https://lawsofux.com/cognitive-load/)
- [Laws of UX: Goal-Gradient Effect](https://lawsofux.com/goal-gradient-effect/)
- [Laws of UX: Zeigarnik Effect](https://lawsofux.com/zeigarnik-effect/)
- [Laws of UX: Peak-End Rule](https://lawsofux.com/peak-end-rule/)
- [NN/g: Visual hierarchy](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/)
- [NN/g: F-shaped pattern](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content-discovered/)
- [NN/g: Text scanning patterns](https://www.nngroup.com/articles/text-scanning-patterns-eyetracking/)
- [NN/g: Proximity](https://www.nngroup.com/articles/gestalt-proximity/)
- [NN/g: Response times, 3 important limits](https://www.nngroup.com/articles/response-times-3-important-limits/)
- [NN/g: Skeleton screens](https://www.nngroup.com/articles/skeleton-screens/)
- [NN/g: Progress indicators](https://www.nngroup.com/articles/progress-indicators/)
- [NN/g: Microinteractions](https://www.nngroup.com/articles/microinteractions/)
- [NN/g: Drag and drop](https://www.nngroup.com/articles/drag-drop/)
- [NN/g: Aesthetic-usability effect](https://www.nngroup.com/articles/aesthetic-usability-effect/)
- [NN/g: Ten usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [WCAG 1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- [WCAG 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [WCAG 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- [WCAG 2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
- [WCAG 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
- [WCAG 2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- [WCAG 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- [A List Apart: Never Use a Warning When You Mean Undo](https://alistapart.com/article/neveruseawarning/)
- [Kivetz, Urminsky, Zheng (2006), abstract on EconPapers](https://econpapers.repec.org/RePEc:feb:natura:00658)
