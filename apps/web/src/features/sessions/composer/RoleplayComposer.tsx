import React, {useCallback, useEffect, useRef} from 'react';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {HistoryPlugin} from '@lexical/react/LexicalHistoryPlugin';
import {OnChangePlugin} from '@lexical/react/LexicalOnChangePlugin';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type EditorState,
} from 'lexical';
import {mergeRegister} from '@lexical/utils';
import {
  normalizeComposerBlocks,
  parseRoleplayForComposer,
  serializeRoleplay,
  trimTrailingEmptyRoleplayLines,
  type RoleplayBlock,
} from '@sillyrealms/roleplay';
import {$createRoleplayBlockNode, $isRoleplayBlockNode, RoleplayBlockNode} from './roleplay-nodes';
import {$exitRoleplayBlock, $removeEmptyRoleplayBlock, normalizeRoleplayBlockPaste} from './composer-operations';

const MAX_LENGTH = 100000;

function $blocks(): RoleplayBlock[] {
  const blocks: RoleplayBlock[] = [];
  for (const child of $getRoot().getChildren()) {
    if ($isRoleplayBlockNode(child)) {
      blocks.push({id: child.getKey(), kind: child.getKind(), text: child.getTextContent()});
    } else if ($isElementNode(child)) {
      blocks.push({id: child.getKey(), kind: 'action', text: child.getTextContent()});
    }
  }
  return blocks;
}

function $replaceDraft(value: string) {
  const root = $getRoot();
  const projection = parseRoleplayForComposer(value, 'user');
  root.clear();
  const instructionIndexes = projection.blocks.flatMap((block, index) => block.kind === 'instruction' ? [index] : []);
  const lastInstructionIndex = instructionIndexes.at(-1) ?? -1;
  const mergedInstruction = instructionIndexes
    .map(index => projection.blocks[index]!.text.replace(/[\r\n]+/g, ' '))
    .filter(text => text.trim())
    .join('；');

  projection.blocks.forEach((block, index) => {
    if (block.kind === 'instruction') {
      if (index === lastInstructionIndex && mergedInstruction) {
        const node = $createRoleplayBlockNode('instruction');
        node.append($createTextNode(mergedInstruction));
        root.append(node);
      }
      return;
    }
    if (block.kind === 'speech') {
      const node = $createRoleplayBlockNode(block.kind);
      const text = block.text.replace(/[\r\n]+/g, ' ');
      if (text) node.append($createTextNode(text));
      root.append(node);
      return;
    }
    const paragraph = $createParagraphNode();
    if (block.text) paragraph.append($createTextNode(block.kind === 'thought' ? block.text.split('\n').map(line=>`> ${line}`).join('\n') : block.text));
    root.append(paragraph);
  });
  if (root.isEmpty()) root.append($createParagraphNode());
  // External drafts replace the tree; restore a valid selection for the next edit.
  const last = root.getLastChild();
  if ($isElementNode(last)) last.selectEnd();
}

function Controls({value, disabled, onChange, onSubmit}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const current = useRef(value), changeRef = useRef(onChange), submitRef = useRef(onSubmit);
  changeRef.current = onChange;
  submitRef.current = onSubmit;

  useEffect(() => {editor.setEditable(!disabled);}, [editor, disabled]);
  useEffect(() => {
    if (value === current.current) return;
    current.current = value;
    editor.update(() => $replaceDraft(value), {tag: 'external-draft'});
  }, [editor, value]);

  useEffect(() => mergeRegister(
    editor.registerCommand(KEY_ENTER_COMMAND, event => {
      if (!event || event.isComposing || editor.isComposing()) return false;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const text = trimTrailingEmptyRoleplayLines(serializeRoleplay(normalizeComposerBlocks($blocks())));
        submitRef.current(text);
        return true;
      }
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const topLevel = selection.anchor.getNode().getTopLevelElementOrThrow();
        if ($isRoleplayBlockNode(topLevel)) {
          event.preventDefault();
          $exitRoleplayBlock(topLevel);
          return true;
        }
      }
      // Plain Enter and Shift+Enter both remain newline operations in action paragraphs.
      return false;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(KEY_BACKSPACE_COMMAND, event => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      const topLevel = selection.anchor.getNode().getTopLevelElementOrThrow();
      if ($isRoleplayBlockNode(topLevel) && !topLevel.getTextContent()) {
        event?.preventDefault();
        $removeEmptyRoleplayBlock(topLevel);
        return true;
      }
      return false;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(PASTE_COMMAND, event => {
      if (!(event instanceof ClipboardEvent)) return false;
      const clipboard = event.clipboardData;
      const text = clipboard?.getData('text/plain');
      if (text === undefined) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      const topLevel = selection.anchor.getNode().getTopLevelElementOrThrow();
      if (!$isRoleplayBlockNode(topLevel) && clipboard?.getData('application/x-lexical-editor')) return false;
      event.preventDefault();
      if ($isRoleplayBlockNode(topLevel)) selection.insertText(normalizeRoleplayBlockPaste(text));
      else selection.insertNodes([$createTextNode(text)]);
      return true;
    }, COMMAND_PRIORITY_HIGH),
  ), [editor]);

  const changed = useCallback((state: EditorState, _editor: unknown, tags: Set<string>) => {
    if (tags.has('external-draft')) return;
    const next = state.read(() => serializeRoleplay(normalizeComposerBlocks($blocks())));
    current.current = next;
    changeRef.current(next);
  }, []);

  return <>
    <OnChangePlugin onChange={changed} ignoreSelectionChange />
    {value.length > MAX_LENGTH && <p className="sr-composer-error" role="alert">消息超过 100000 字符，请缩短后发送。</p>}
  </>;
}

/** Host-owned block editor; the serialized SR-RP v1 text is its only outward representation. */
export function RoleplayComposer({value, disabled, onChange, onSubmit}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
}) {
  const initial = useRef(value);
  return <LexicalComposer initialConfig={{
    namespace: 'SRRoleplay',
    nodes: [RoleplayBlockNode],
    editable: !disabled,
    onError: error => {throw error;},
    editorState: () => $replaceDraft(initial.current),
  }}>
    <div className="sr-roleplay-composer">
      <Controls value={value} disabled={disabled} onChange={onChange} onSubmit={onSubmit}/>
      <div className="sr-composer-editor-wrap">
        <RichTextPlugin contentEditable={<ContentEditable className="sr-composer-editor" role="textbox" aria-label="输入消息" aria-multiline="true" aria-placeholder="写下你的回应…" placeholder={<span className="sr-composer-placeholder">写下你的回应…</span>} />} ErrorBoundary={LexicalErrorBoundary}/>
      </div>
      <HistoryPlugin />
    </div>
  </LexicalComposer>;
}
