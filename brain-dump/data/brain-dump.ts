/**
 * brain-dump tuning: when a prompt counts as a brain dump (length and trigger
 * phrases), the two model calls (clarifying questions, then the rewrite) with
 * their prompts, the rewrite's section headings, the question limits, what
 * happens on a closed offer or a failed rewrite, colours, hotkeys and every
 * line of text. A plain TypeScript literal (a hooks module can only import
 * script files); the type checker holds it to `Tuning`, and the tests import
 * this same file.
 */

import type { Tuning } from '../types'

export const tuning: Tuning = {
  startOn: true,
  // Only prompts a person typed: the composer, and a remote composer (mobile, web).
  origins: ['composer', 'bridge'],
  minWords: 150,
  triggerMinWords: 25,
  triggers: [
    { id: 'brain-dump', pattern: String.raw`\bbrain[\s-]?dump(ing)?\b` },
    { id: 'rambling', pattern: String.raw`\b(sorry (for|about) the ramble|i'?m rambling|bear with me)\b` },
    { id: 'thinking-aloud', pattern: String.raw`\b(thinking out loud|thinking aloud|stream of consciousness)\b` },
  ],
  patternFlags: 'i',
  onDismiss: 'keep',
  restoreOnFailure: true,
  refillDelayMs: 150,
  // The question dialog takes 2 to 4 options.
  maxQuestions: 3,
  minOptions: 2,
  maxOptions: 4,
  maxOptionChars: 60,
  questions: { model: 'haiku', maxTokens: 800, timeoutMs: 30000 },
  rewrite: { model: 'sonnet', maxTokens: 3000, timeoutMs: 120000 },
  headingMark: '## ',
  sections: [
    { heading: 'Task', purpose: 'What to do, in concrete terms.' },
    { heading: 'Why', purpose: 'The purpose and background, so the assistant can make sound judgment calls.' },
    { heading: 'Guardrails', purpose: 'Constraints, preferences, limits of scope and things to avoid.' },
    { heading: 'Done looks like', purpose: 'What finished means: what is delivered, in what form, to what standard.' },
  ],
  requireAllSections: true,
  fence: '```',
  glyph: '◇',
  colors: { offer: 'suggestion', detail: 'inactive', busy: 'warning' },
  hotkeys: { structure: 's', dismiss: 'x' },
  outcomeNames: {
    filled: 'the structured prompt was put in the box',
    copied: 'the structured prompt was copied to the clipboard',
    failed: 'the rewrite failed and the original went back in the box',
    sent: 'the rewrite failed and the original was sent as written',
    kept: 'the offer was closed and the prompt went back in the box',
  },
  text: {
    header: 'Brain dump',
    offer: 'This reads like a brain dump ({words} words). Restructure it into a clear prompt you can review before sending?',
    structure: 'Restructure it',
    sendAsIs: 'Send as is',
    dropped: 'Brain dump: not sent. The restructured prompt will land in the box for you to review.',
    keptBack: 'Brain dump: not sent. Your prompt is back in the box.',
    asking: 'Brain dump: looking for what is unclear…',
    writing: 'Brain dump: drafting the structured prompt…',
    filled: 'Brain dump: the structured prompt is in the box. Review it, then send it yourself.',
    copied: 'Brain dump: the box has changed, so the structured prompt was copied to the clipboard instead.',
    failedRestored: 'Brain dump: the restructure failed. Your prompt is back in the box as you wrote it.',
    failedCopied: 'Brain dump: could not put the text in the box; it was copied to the clipboard.',
    failedUntouched: 'Brain dump: the restructure failed. Your draft is unchanged.',
    started: 'Brain dump: restructuring your draft. It will land in the box for you to review.',
    busy: 'Brain dump: already restructuring a prompt; wait for it to land.',
    bandOffer: '{glyph} brain dump?',
    bandWords: '{words} words',
    bandTrigger: 'says "{trigger}"',
    bandBusy: '{glyph} restructuring…',
    bandJoin: ' · ',
    bandStructure: 'Restructure',
    bandDismiss: 'Not this one',
    on: 'brain-dump is on: long or rambling prompts are offered a restructure before they are sent.',
    off: 'brain-dump is off: prompts go out as written until /brain-dump on.',
    status: 'brain-dump is {state}. A prompt counts from {words} words, or {triggerWords} with a trigger phrase ({triggers}). Questions by {questionsModel}, rewrite by {rewriteModel}. Last run: {last}.',
    stateOn: 'on',
    stateOff: 'off',
    statusNever: 'none yet',
    nothingToStructure: 'Nothing to restructure: type the prompt first, then run /brain-dump now (or press Restructure above the prompt).',
    usage: 'Usage: /brain-dump on | off | status | now',
    commandDescription: 'Brain dump: on, off, status, or now to restructure the current draft',
    questionsSystem: [
      'You read a rough, rambling prompt that a person dictated or typed for an AI coding assistant, and find the gaps that would change the work: the goal, the scope, who or what it is for, the form of the result, statements that conflict, and how to tell it is finished.',
      '',
      'Reply with JSON and nothing else, in this shape: {"questions":[{"question":"...?","options":["...","..."]}]}',
      '- Ask {max} questions at most, and only ones whose answer matters. No questions is a fine reply: {"questions":[]}.',
      '- Each question is one short sentence ending in "?", with {minOptions} to {maxOptions} likely answers of a few words each.',
    ].join('\n'),
    rewriteSystem: [
      'You rewrite a rough, rambling prompt into one clear prompt for an AI coding assistant.',
      '',
      '- Keep everything the person asked for. Drop filler and repeats, fix obvious dictation slips, and settle contradictions with their answers; with no answer, the later statement wins.',
      '- Add no requirement they did not state or clearly imply.',
      '- Write as the person, in the first person, speaking to the assistant.',
      '- Reply with the prompt alone, under exactly these headings, in this order:',
      '',
      '{sections}',
    ].join('\n'),
    sectionLine: '{mark}{heading}\n{purpose}',
    sectionJoin: '\n\n',
    request: 'The rough prompt:\n<draft>\n{text}\n</draft>{answers}',
    answers: '\n\nTheir answers to clarifying questions:\n<answers>\n{pairs}\n</answers>',
    answerPair: 'Q: {question}\nA: {answer}',
    answerJoin: '\n\n',
  },
}
