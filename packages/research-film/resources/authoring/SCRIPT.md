# The script standard

The script is the voice lines (`caption` and `say`) of every scene. It carries the video: the panels and animations illustrate what the voice says, so a weak script can't be saved by good visuals. This is the bar every script meets, whichever model writes it. Read it before step 3 of SKILL.md, and score your draft against the rubric at the end before you run `check`.

The strong examples below are lines from finished AIPOCH videos. The weak ones are what the same line looks like without this standard.

## 1 · Before you write a line: the spine

Write these four things down first, in plain words, from the session:

1. **The question** the hook asks (one sentence a stranger would care about).
2. **The answer** the outro gives (one sentence, a direct reply to that question).
3. **The catch:** the surprise, tension or twist that makes the answer interesting (a gap, a failure, a number that moves the wrong way, a limit the agent admitted).
4. **The 2–3 numbers that matter.** A session has dozens of numbers; the video shows the few that carry the answer and the catch. The rest stay in panels or out.

If you can't write the answer and the catch, you don't understand the research yet: go back to the session (SKILL.md step 2).

> Spine, case 016. Question: can an AI make good packing trade-offs by judgment alone? Answer: it came 10 points short of the best list. Catch: the "best" list is measured against the AI's own scores, and it keeps a hairdryer while leaving the wool coat. Numbers: 152 vs 162, 2.57 kg.

## 2 · The story

- **One thread, question to answer.** Every scene moves the spine forward. A scene that doesn't help answer the hook's question is cut, however true it is.
- **Each scene answers what the previous one raised.** Use the hinge words that show it: _But…_, _So…_, _Then…_, _Yet…_, _And…_. A short question as a hinge works well, as long as the next words answer it.
  - Strong: "So does the definition change the picture? Barely: the total moves 1.08%."
  - Weak: "The next analysis compared the results across thresholds."
- **Land the catch.** The result scene shows the finding, then the twist: "But the average hides the spread."
- **Say the limits plainly,** as findings, not apologies: "Storing it isn't running it."
- **The outro answers the hook,** in one plain line before the closing line. It reads as the reply to the opening question.
  - Strong (hook "Can AI make good trade-offs packing a suitcase?"): "Judgment alone came 10 points short, and the AI said so plainly."
  - Weak: "This session demonstrates the value of careful verification."

## 3 · Lines

- **One idea per line.** Most lines land at about **4–8 seconds** spoken (about 9–18 words; our median is 12 words, 4.8 s). That is a guide, not a limit: when a point needs a longer line to finish, keep it whole rather than break it mid-thought. What matters is that the line carries one idea and the listener can follow it. A long line doesn't crowd the screen: captions appear in short phrases as they are spoken, each sized to fit on one row inside the safe zone (a line can hold up to 220 characters). Avoid single words so long they can't fit a phrase (about 20 characters in 9:16); `layout` reports them. A scene has 1–3 lines.
- **A concrete subject and a verb that says what happened.** Not "an analysis was performed", but who did what to what.
  - Strong: "An Open-Science agent rebuilt the fit from scratch."
  - Weak: "An analysis of the fitting procedure was carried out."
- **Every number carries its meaning:** what it measures, its unit, and what it is compared with. A bare number is noise.
  - Strong: "Then 2024: 6,732 hectares." (after "It dips to 1,046 in 2023.")
  - Weak: "The value was 6,732."
- **At most 2–3 numbers in a line,** and fewer when they are long. Prefer the comparison to the raw values ("6.43×", "10 points short", "26 times wider"). Read out only the numbers the panel shows at that moment.
- **Plain words.** Explain a technical term the first time, in a few words, or replace it.
  - Strong: "Take away self-augmentation, a training trick."
  - Weak: "Ablating the self-augmentation component yields the following deltas."
- **Short lines hit; long lines explain.** Mix them. A 2–4 word line after a long one lands the point: "Barely." "Twenty fits." "Really?"
- **Name the agent the same way:** "An Open-Science agent" the first time, then "the agent" or "it". When the research is _about_ an AI (a benchmark, a model's choices), "the AI" is the subject, and the agent stays "the agent".
- **The caption is what is said.** `say` only spells out numbers, units and symbols for the voice; it doesn't add or drop words.

## 4 · Never

- **Setup and filler:** "In this session…", "In this video…", "Let's take a look…", "It's worth noting that…", "Interestingly,…", "As we can see…", "Here we see…", "In conclusion…", "To summarize…".
- **Hype the session doesn't support:** "revolutionary", "groundbreaking", "game-changing", "incredible", "mind-blowing", "stunning", "unprecedented". Let the number be the surprise.
- **Hedge stacks:** "it may possibly suggest that it could…". Say what the session says, with its own qualifier, once: "Recorded coverage, not a probability of future success."
- **Reading the panel aloud as a list,** or reading file names, paths, code or column names.
- **A question nobody answers,** and **a number nobody explains**.
- **Claims the session doesn't make.** Every fact on the voice track is in the session, like every number on screen.

## 5 · Scene recipes

| Role     | The lines…                                                                                                                                                   | Example (finished video)                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook`   | 1: a punch of about 6 words (the news, the tension or a surprising number). 2: the claim and the question. 3: the agent line, with the pill note cued to it. | "Twenty tokens per parameter. Really?" / "Chinchilla's scaling law set that rule. Epoch AI says its fit misses its own data." / "An Open-Science agent rebuilt the fit from scratch." |
| `setup`  | What was given or assumed, with anything hypothetical said as such.                                                                                          | "The study area: a fixed box near Iberia, Peru, 482.90 km², set before looking at any loss."                                                                                          |
| `method` | How it was done, as a chain of verbs; the one idea a viewer needs to follow the rest.                                                                        | "The wheels turn by distance; the crank follows through a 44 to 18 gear."                                                                                                             |
| `result` | The finding with its meaning, then the catch.                                                                                                                | "5 marked correct before editing, 47 after: 5% to 47%." / "But the average hides the spread."                                                                                         |
| `limit`  | What doesn't hold or wasn't tested, plainly.                                                                                                                 | "What drove 2024, fire, clearing or something else, the maps can't tell."                                                                                                             |
| `check`  | The verification, or the researcher's pushback and what came of it.                                                                                          | "Then the agent checked its own work."                                                                                                                                                |
| `outro`  | The answer to the hook in one line, then the closing line (SKILL.md).                                                                                        | "Better-looking pictures don't guarantee consistency, and which metrics you pick changes the verdict."                                                                                |

## 6 · Rubric: score the draft before `check`

Read only the voice lines, in order, as if there were no picture. Then mark each criterion pass or fail. **Rewrite every line that fails, then score again.** Report the final score to the user with the preview.

1. **Spine:** the hook asks one clear question, and the outro's answer line replies to it.
2. **Catch:** the script has a surprise, tension or twist, and it lands in a result or limit scene.
3. **Thread:** every scene follows from the one before (hinge words), and none could be cut without losing the answer.
4. **Audio only:** a listener who never sees the screen still understands the story.
5. **Numbers:** each has its meaning and unit; no line has more than 3; the key 2–3 numbers are said, the rest are left to panels.
6. **Plain words:** every technical term is explained the first time, or replaced.
7. **Line craft:** one idea per line (most at about 4–8 s; longer when the point needs it), concrete subjects and real verbs, a mix of short and long lines.
8. **Clean:** no filler, hype or hedge stacks (section 4), and the agent is named the same way throughout.
9. **True:** every fact and number is in the session, and limits are stated as the session states them.

`check` warns about what it can measure (filler and hype words, lines that run long (a prompt to look again, not a limit), lines with more than three numbers, an outro without an answer line). It can't judge the story: the rubric is how you do.
