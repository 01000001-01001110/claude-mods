//! Every tunable and every line of text chat-inventory shows: the sections of
//! the "In this chat" pane and their order, limits, glyphs and colours, which
//! tools count as file reads or writes, how connector names are cleaned, the
//! inline summary and the command's replies. The hooks and the tests import
//! this one file, so a re-tune here is what ships and what is tested.

import type { Tuning } from '../types'

/** The shipped tuning. */
export const tuning: Tuning = {
  pane: {
    title: 'In this chat',
    dockColumns: 44,
    inlineRows: 3,
    openAtStart: true,
    minColumns: 20,
    sectionGap: 1,
  },
  sections: [
    { id: 'goal', heading: 'GOAL', isOpen: true, hideWhenEmpty: false, empty: 'Nothing asked yet.', rows: 0 },
    { id: 'todo', heading: 'TO-DO {done}/{total}', isOpen: true, hideWhenEmpty: true, empty: 'No to-do list yet.', rows: 20 },
    { id: 'connectors', heading: 'CONNECTORS {n}', isOpen: true, hideWhenEmpty: false, empty: 'None called yet.', rows: 12 },
    { id: 'skills', heading: 'SKILLS {n}', isOpen: true, hideWhenEmpty: true, empty: 'No skills used yet.', rows: 12 },
    { id: 'files', heading: 'FILES {n}', isOpen: true, hideWhenEmpty: false, empty: 'No files read or written yet.', rows: 30 },
    { id: 'tools', heading: 'TOOLS {n}', isOpen: false, hideWhenEmpty: true, empty: 'No tools called yet.', rows: 0 },
  ],
  goal: {
    maxChars: 160,
  },
  todo: {
    barWidth: 24,
    listTools: ['TodoWrite'],
    createTool: 'TaskCreate',
    updateTool: 'TaskUpdate',
    planSuffix: 'update_plan',
  },
  files: {
    keep: 100,
    tools: {
      Read: { pathKey: 'file_path', action: 'read' },
      NotebookRead: { pathKey: 'notebook_path', action: 'read' },
      Edit: { pathKey: 'file_path', action: 'edit' },
      MultiEdit: { pathKey: 'file_path', action: 'edit' },
      NotebookEdit: { pathKey: 'notebook_path', action: 'edit' },
      Write: { pathKey: 'file_path', action: 'write' },
    },
    countMentions: true,
  },
  connectors: {
    strip: [String.raw`^plugin_[^_]+_`, String.raw`^claude-in-`, String.raw`^claude_ai_`],
    hide: [String.raw`^ccd_`],
  },
  tools: {
    hide: [],
    skillTool: 'Skill',
  },
  glyphs: {
    open: '▾',
    closed: '▸',
    todo: { todo: '☐', doing: '▶', done: '☑' },
    file: { new: '+', edit: '~', read: '·' },
    connector: '◆',
    skill: '✦',
    count: '×',
    barFull: '█',
    barEmpty: '░',
    ellipsis: '…',
    separator: ' · ',
  },
  colors: {
    heading: 'subtle',
    bar: 'suggestion',
    count: 'inactive',
    file: { new: 'success', edit: 'warning', read: 'inactive' },
    todo: { todo: 'text', doing: 'claude', done: 'inactive' },
  },
  inline: {
    lead: 'In this chat',
    parts: [
      { id: 'todo', text: 'to-do {done}/{total}' },
      { id: 'files', text: '{n} files' },
      { id: 'connectors', text: '{n} connectors' },
      { id: 'skills', text: '{n} skills' },
      { id: 'tools', text: '{n} tool calls' },
    ],
    empty: 'nothing used yet',
  },
  command: {
    description: 'The "In this chat" pane: /inventory open | close | reset',
    open: 'open',
    close: 'close',
    reset: 'reset',
  },
  text: {
    more: '+{n} more',
    opened: 'Opened "In this chat".',
    notPlaced: '"In this chat" is waiting for room: {reason}.',
    closed: 'Closed "In this chat".',
    reset: 'Cleared "In this chat".',
    usage: 'Usage: /inventory open | close | reset',
  },
}
