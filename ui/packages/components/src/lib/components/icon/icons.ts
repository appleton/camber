import type { Component } from "svelte";
import type { Schema } from "type-fest";
import Admin from "./glyphs/admin.svelte";
import Alert from "./glyphs/alert.svelte";
import Apply from "./glyphs/apply.svelte";
import Archive from "./glyphs/archive.svelte";
import ArrowDownCircle from "./glyphs/arrow-down-circle.svelte";
import ArrowLeftDown from "./glyphs/arrow-left-down.svelte";
import ArrowLeft from "./glyphs/arrow-left.svelte";
import ArrowRight from "./glyphs/arrow-right.svelte";
import ArrowUpRight from "./glyphs/arrow-up-right.svelte";
import Ask from "./glyphs/ask.svelte";
import Block from "./glyphs/block.svelte";
import Bolt from "./glyphs/bolt.svelte";
import Bug from "./glyphs/bug.svelte";
import Bulb from "./glyphs/bulb.svelte";
import Chats from "./glyphs/chats.svelte";
import Checked from "./glyphs/checked.svelte";
import Checkmark from "./glyphs/checkmark.svelte";
import Chevron from "./glyphs/chevron.svelte";
import Clear from "./glyphs/clear.svelte";
import Clock from "./glyphs/clock.svelte";
import CloseCircle from "./glyphs/close-circle.svelte";
import Code from "./glyphs/code.svelte";
import CollapseAll from "./glyphs/collapse-all.svelte";
import CollapseBoth from "./glyphs/collapse-both.svelte";
import Command from "./glyphs/command.svelte";
import Compare from "./glyphs/compare.svelte";
import Config from "./glyphs/config.svelte";
import Context from "./glyphs/context.svelte";
import Convert from "./glyphs/convert.svelte";
import Copied from "./glyphs/copied.svelte";
import Copy from "./glyphs/copy.svelte";
import Cross from "./glyphs/cross.svelte";
import Dark from "./glyphs/dark.svelte";
import Debug from "./glyphs/debug.svelte";
import Delete from "./glyphs/delete.svelte";
import Demo from "./glyphs/demo.svelte";
import Diff from "./glyphs/diff.svelte";
import Discard from "./glyphs/discard.svelte";
import Dot from "./glyphs/dot.svelte";
import Edit from "./glyphs/edit.svelte";
import Email from "./glyphs/email.svelte";
import Enter from "./glyphs/enter.svelte";
import Error from "./glyphs/error.svelte";
import ExpandAll from "./glyphs/expand-all.svelte";
import ExpandBoth from "./glyphs/expand-both.svelte";
import ExpandDown from "./glyphs/expand-down.svelte";
import ExpandUp from "./glyphs/expand-up.svelte";
import Export from "./glyphs/export.svelte";
import EyeHidden from "./glyphs/eye-hidden.svelte";
import EyeVisible from "./glyphs/eye-visible.svelte";
import FastForward from "./glyphs/fast-forward.svelte";
import FileActive from "./glyphs/file-active.svelte";
import FileGo from "./glyphs/file-go.svelte";
import File from "./glyphs/file.svelte";
import FilesWebsites from "./glyphs/files-websites.svelte";
import Files from "./glyphs/files.svelte";
import FolderClosed from "./glyphs/folder-closed.svelte";
import FolderOpen from "./glyphs/folder-open.svelte";
import FolderPlus from "./glyphs/folder-plus.svelte";
import Folder from "./glyphs/folder.svelte";
import Gear from "./glyphs/gear.svelte";
import GitBranch from "./glyphs/git-branch.svelte";
import GitCommit from "./glyphs/git-commit.svelte";
import GitMessage from "./glyphs/git-message.svelte";
import GitHub from "./glyphs/github.svelte";
import History from "./glyphs/history.svelte";
import IDE from "./glyphs/ide.svelte";
import Info from "./glyphs/info.svelte";
import Key from "./glyphs/key.svelte";
import Keyboard from "./glyphs/keyboard.svelte";
import Lab from "./glyphs/lab.svelte";
import Leg from "./glyphs/leg.svelte";
import Light from "./glyphs/light.svelte";
import Link from "./glyphs/link.svelte";
import LoadConfig from "./glyphs/load-config.svelte";
import MCPAlert from "./glyphs/mcp-alert.svelte";
import MCPReady from "./glyphs/mcp-ready.svelte";
import MCP from "./glyphs/mcp.svelte";
import Microphone from "./glyphs/microphone.svelte";
import Minus from "./glyphs/minus.svelte";
import More from "./glyphs/more.svelte";
import New from "./glyphs/new.svelte";
import Output from "./glyphs/output.svelte";
import Package from "./glyphs/package.svelte";
import PanelBottomClosed from "./glyphs/panel-bottom-closed.svelte";
import PanelBottomOpen from "./glyphs/panel-bottom-open.svelte";
import Pause from "./glyphs/pause.svelte";
import Pencil from "./glyphs/pencil.svelte";
import Plan from "./glyphs/plan.svelte";
import PlusCircle from "./glyphs/plus-circle.svelte";
import Plus from "./glyphs/plus.svelte";
import Readme from "./glyphs/readme.svelte";
import Reapply from "./glyphs/reapply.svelte";
import Regenerate from "./glyphs/regenerate.svelte";
import RemoteAccess from "./glyphs/remote-access.svelte";
import Restore from "./glyphs/restore.svelte";
import Revert from "./glyphs/revert.svelte";
import Review from "./glyphs/review.svelte";
import RotateCcw from "./glyphs/rotate-ccw.svelte";
import Roundel from "./glyphs/roundel.svelte";
import Run from "./glyphs/run.svelte";
import Sandbox from "./glyphs/sandbox.svelte";
import Search from "./glyphs/search.svelte";
import Send from "./glyphs/send.svelte";
import Shield from "./glyphs/shield.svelte";
import SidebarHide from "./glyphs/sidebar-hide.svelte";
import SidebarLeftClosed from "./glyphs/sidebar-left-closed.svelte";
import SidebarLeftOpen from "./glyphs/sidebar-left-open.svelte";
import SidebarRightClosed from "./glyphs/sidebar-right-closed.svelte";
import SidebarRightOpen from "./glyphs/sidebar-right-open.svelte";
import SidebarShow from "./glyphs/sidebar-show.svelte";
import Skills from "./glyphs/skills.svelte";
import Slash from "./glyphs/slash.svelte";
import SparklesSlash from "./glyphs/sparkles-slash.svelte";
import Sparkles from "./glyphs/sparkles.svelte";
import Star from "./glyphs/star.svelte";
import Start from "./glyphs/start.svelte";
import StepAbove from "./glyphs/step-above.svelte";
import StepBelow from "./glyphs/step-below.svelte";
import Stop from "./glyphs/stop.svelte";
import SubmitAdditionalSolid from "./glyphs/submit-additional-solid.svelte";
import SubmitAdditional from "./glyphs/submit-additional.svelte";
import SubmitSolid from "./glyphs/submit-solid.svelte";
import Submit from "./glyphs/submit.svelte";
import SymbolCode from "./glyphs/symbol-code.svelte";
import SymbolType from "./glyphs/symbol-type.svelte";
import SymbolValue from "./glyphs/symbol-value.svelte";
import Symbols from "./glyphs/symbols.svelte";
import System from "./glyphs/system.svelte";
import Target from "./glyphs/target.svelte";
import TaskNew from "./glyphs/task-new.svelte";
import Task from "./glyphs/task.svelte";
import TerminalActive from "./glyphs/terminal-active.svelte";
import TerminalDone from "./glyphs/terminal-done.svelte";
import Terminal from "./glyphs/terminal.svelte";
import Thread from "./glyphs/thread.svelte";
import ThumbsDown from "./glyphs/thumbs-down.svelte";
import ThumbsUp from "./glyphs/thumbs-up.svelte";
import TodoComplete from "./glyphs/todo-complete.svelte";
import TodoPending from "./glyphs/todo-pending.svelte";
import Trash from "./glyphs/trash.svelte";
import UserSmall from "./glyphs/user-small.svelte";
import User from "./glyphs/user.svelte";
import VsCode from "./glyphs/vscode.svelte";
import Wand from "./glyphs/wand.svelte";
import Web from "./glyphs/web.svelte";
import type { ProductIconProps } from "./Icon.svelte";
import type { IconName } from "./IconName.js";

export const iconMap: Record<IconName, Component> = {
  admin: Admin,
  alert: Alert,
  apply: Apply,
  archive: Archive,
  "arrow-down-circle": ArrowDownCircle,
  "arrow-left": ArrowLeft,
  "arrow-left-down": ArrowLeftDown,
  "arrow-right": ArrowRight,
  "arrow-up-right": ArrowUpRight,
  ask: Ask,
  block: Block,
  bolt: Bolt,
  bug: Bug,
  bulb: Bulb,
  chats: Chats,
  checked: Checked,
  checkmark: Checkmark,
  chevron: Chevron,
  clear: Clear,
  clock: Clock,
  "close-circle": CloseCircle,
  code: Code,
  "collapse-all": CollapseAll,
  "collapse-both": CollapseBoth,
  command: Command,
  compare: Compare,
  config: Config,
  context: Context,
  convert: Convert,
  copied: Copied,
  copy: Copy,
  cross: Cross,
  dark: Dark,
  debug: Debug,
  delete: Delete,
  demo: Demo,
  diff: Diff,
  discard: Discard,
  dot: Dot,
  edit: Edit,
  email: Email,
  enter: Enter,
  error: Error,
  "expand-all": ExpandAll,
  "expand-both": ExpandBoth,
  "expand-down": ExpandDown,
  "expand-up": ExpandUp,
  export: Export,
  "eye-hidden": EyeHidden,
  "eye-visible": EyeVisible,
  "fast-forward": FastForward,
  "file-active": FileActive,
  "file-go": FileGo,
  file: File,
  files: Files,
  "files-websites": FilesWebsites,
  folder: Folder,
  "folder-closed": FolderClosed,
  "folder-open": FolderOpen,
  "folder-plus": FolderPlus,
  gear: Gear,
  "git-branch": GitBranch,
  "git-commit": GitCommit,
  "git-message": GitMessage,
  github: GitHub,
  history: History,
  ide: IDE,
  info: Info,
  key: Key,
  keyboard: Keyboard,
  lab: Lab,
  leg: Leg,
  light: Light,
  link: Link,
  "load-config": LoadConfig,
  mcp: MCP,
  "mcp-alert": MCPAlert,
  "mcp-ready": MCPReady,
  microphone: Microphone,
  minus: Minus,
  more: More,
  new: New,
  output: Output,
  "panel-bottom-closed": PanelBottomClosed,
  "panel-bottom-open": PanelBottomOpen,
  package: Package,
  pause: Pause,
  pencil: Pencil,
  plan: Plan,
  "plus-circle": PlusCircle,
  plus: Plus,
  readme: Readme,
  reapply: Reapply,
  regenerate: Regenerate,
  "remote-access": RemoteAccess,
  restore: Restore,
  revert: Revert,
  review: Review,
  "rotate-ccw": RotateCcw,
  roundel: Roundel,
  run: Run,
  sandbox: Sandbox,
  search: Search,
  send: Send,
  shield: Shield,
  "sidebar-hide": SidebarHide,
  "sidebar-left-closed": SidebarLeftClosed,
  "sidebar-left-open": SidebarLeftOpen,
  "sidebar-right-closed": SidebarRightClosed,
  "sidebar-right-open": SidebarRightOpen,
  "sidebar-show": SidebarShow,
  skills: Skills,
  slash: Slash,
  "sparkles-slash": SparklesSlash,
  sparkles: Sparkles,
  star: Star,
  start: Start,
  "step-above": StepAbove,
  "step-below": StepBelow,
  stop: Stop,
  submit: Submit,
  "submit-additional": SubmitAdditional,
  "submit-additional-solid": SubmitAdditionalSolid,
  "submit-solid": SubmitSolid,
  "symbol-code": SymbolCode,
  "symbol-type": SymbolType,
  "symbol-value": SymbolValue,
  symbols: Symbols,
  system: System,
  task: Task,
  "task-new": TaskNew,
  target: Target,
  terminal: Terminal,
  "terminal-active": TerminalActive,
  "terminal-done": TerminalDone,
  thread: Thread,
  "thumbs-down": ThumbsDown,
  "thumbs-up": ThumbsUp,
  "todo-complete": TodoComplete,
  "todo-pending": TodoPending,
  trash: Trash,
  user: User,
  "user-small": UserSmall,
  vscode: VsCode,
  wand: Wand,
  web: Web,
};

export const iconVariantSupport: Record<
  IconName,
  Schema<Pick<ProductIconProps, "dashed" | "gradient" | "weight">, boolean>
> = {
  admin: { weight: true },
  alert: { weight: true },
  apply: { weight: true },
  archive: { weight: true },
  "arrow-down-circle": { weight: true },
  "arrow-left": { weight: true },
  "arrow-left-down": { weight: true },
  "arrow-right": { weight: true },
  "arrow-up-right": { weight: true },
  ask: { weight: true },
  block: { weight: true },
  bolt: { weight: true },
  bug: { weight: true },
  bulb: { weight: true },
  chats: { weight: true, dashed: true },
  checked: { weight: true },
  checkmark: { weight: true },
  chevron: { weight: true },
  clear: { weight: true },
  clock: { weight: true, dashed: true },
  "close-circle": { weight: true },
  code: { weight: true },
  "collapse-all": { weight: true },
  "collapse-both": { weight: true },
  command: { weight: true },
  compare: { weight: true, dashed: true },
  config: { weight: true },
  context: { weight: true },
  convert: { weight: true },
  copied: { weight: true },
  copy: { weight: true },
  cross: { weight: true },
  dark: { weight: false },
  debug: { weight: true },
  delete: { weight: true },
  demo: { weight: true },
  diff: { weight: true },
  discard: { weight: true },
  dot: { weight: true },
  edit: { weight: true },
  email: { weight: true },
  enter: { weight: true },
  error: { weight: true },
  "expand-all": { weight: true },
  "expand-both": { weight: true },
  "expand-down": { weight: true },
  "expand-up": { weight: true },
  export: { weight: true },
  "eye-hidden": { weight: true },
  "eye-visible": { weight: true },
  "fast-forward": { weight: true },
  "file-active": { weight: true },
  "file-go": { weight: true },
  file: { weight: true },
  files: { weight: true, dashed: true },
  "files-websites": { weight: true },
  folder: { weight: true, dashed: true },
  "folder-closed": { weight: true },
  "folder-open": { weight: true },
  "folder-plus": { weight: true },
  gear: { weight: true },
  "git-branch": { weight: true },
  "git-commit": { weight: true },
  "git-message": { weight: true },
  github: {},
  history: { weight: true },
  ide: { weight: true },
  info: { weight: true },
  key: { weight: true },
  keyboard: { weight: true },
  lab: { weight: true },
  leg: { weight: true },
  light: { weight: false },
  link: { weight: true },
  "load-config": { weight: true },
  mcp: { weight: true, dashed: true },
  "mcp-alert": { weight: true },
  "mcp-ready": { weight: true },
  microphone: { weight: true },
  minus: { weight: true },
  more: { weight: true },
  new: { weight: true },
  output: { weight: true },
  "panel-bottom-closed": { weight: true },
  "panel-bottom-open": { weight: true },
  package: { weight: true },
  pause: { weight: true },
  pencil: { weight: true },
  plan: { weight: true },
  "plus-circle": { weight: true, gradient: true },
  plus: { weight: true },
  readme: { weight: true },
  reapply: { weight: true },
  regenerate: { weight: true },
  "remote-access": { weight: true },
  restore: { weight: true },
  revert: { weight: true },
  review: { weight: true },
  "rotate-ccw": { weight: true },
  roundel: { weight: true },
  run: { weight: true },
  sandbox: { weight: true },
  search: { weight: true },
  send: { weight: true },
  shield: { weight: true },
  "sidebar-hide": { weight: true },
  "sidebar-left-closed": { weight: true },
  "sidebar-left-open": { weight: true },
  "sidebar-right-closed": { weight: true },
  "sidebar-right-open": { weight: true },
  "sidebar-show": { weight: true },
  skills: { weight: true },
  slash: { weight: true },
  "sparkles-slash": { weight: true },
  sparkles: { weight: true },
  star: { weight: true, dashed: true },
  start: { weight: true },
  "step-above": { weight: true },
  "step-below": { weight: true },
  stop: { weight: true },
  submit: { weight: true },
  "submit-additional": { weight: true },
  "submit-additional-solid": { weight: true },
  "submit-solid": { weight: true },
  "symbol-code": { weight: true },
  "symbol-type": { weight: true },
  "symbol-value": { weight: true },
  symbols: { weight: true, dashed: true },
  system: { weight: false },
  task: { weight: true },
  "task-new": { weight: true },
  target: { weight: true },
  terminal: { weight: true },
  "terminal-active": { weight: true },
  "terminal-done": { weight: true },
  thread: { weight: true },
  "thumbs-down": { weight: true },
  "thumbs-up": { weight: true },
  "todo-complete": { weight: true },
  "todo-pending": { weight: true },
  trash: { weight: true },
  user: { weight: true },
  "user-small": { weight: true },
  vscode: { weight: true },
  wand: { weight: true },
  web: { weight: true },
};
