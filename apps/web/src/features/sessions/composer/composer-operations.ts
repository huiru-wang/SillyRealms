import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {$createRoleplayBlockNode, $isRoleplayBlockNode, type RoleplayBlockKind} from './roleplay-nodes.ts';

export function normalizeRoleplayBlockPaste(text: string): string {
  return text.replace(/\r?\n/g, ' ');
}

export function $isBlankParagraph(node: LexicalNode | null | undefined): boolean {
  return $isParagraphNode(node) && !$isRoleplayBlockNode(node) && node.getTextContent().trim() === '';
}

/**
 * Inserts a typed block at the current selection. A blank action row is replaced;
 * a non-empty action row is split around the caret and the typed block is inserted between.
 */
export function $insertRoleplayBlock(kind: RoleplayBlockKind) {
  const root = $getRoot();
  if (kind === 'instruction') {
    const existing = root.getChildren().find(node => $isRoleplayBlockNode(node) && node.getKind() === 'instruction');
    const block = existing && $isRoleplayBlockNode(existing) ? existing : $createRoleplayBlockNode(kind);
    if (existing) existing.remove();
    // Replace the current trailing blank row when present; preserve earlier blank rows.
    const last = root.getLastChild();
    if ($isBlankParagraph(last) && $isParagraphNode(last)) last.replace(block);
    else root.append(block);
    block.selectEnd();
    return block;
  }

  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const current = selection.anchor.getNode().getTopLevelElementOrThrow();
  const block = $createRoleplayBlockNode(kind);

  if ($isRoleplayBlockNode(current)) {
    const next = current.getNextSibling();
    if ($isParagraphNode(next) && $isBlankParagraph(next)) next.replace(block);
    else current.insertAfter(block);
    block.selectStart();
    return block;
  }

  if (!$isParagraphNode(current)) return null;
  if ($isBlankParagraph(current)) {
    current.replace(block);
    block.selectStart();
    return block;
  }

  const suffix = selection.insertParagraph();
  if (!suffix) return null;
  if (current.getTextContent().trim() === '') current.replace(block);
  else suffix.insertBefore(block);
  if ($isBlankParagraph(suffix)) suffix.remove();
  block.selectStart();
  return block;
}

/** Enter in a typed block exits into the following action paragraph without adding an extra row. */
export function $exitRoleplayBlock(block: ElementNode) {
  const next = block.getNextSibling();
  if ($isParagraphNode(next) && $isBlankParagraph(next)) {
    next.selectStart();
    return next;
  }
  const paragraph = $createParagraphNode();
  block.insertAfter(paragraph);
  paragraph.selectStart();
  return paragraph;
}

/** Removes an empty typed block and restores a usable action caret. */
export function $removeEmptyRoleplayBlock(block: ElementNode) {
  const previous = block.getPreviousSibling();
  const next = block.getNextSibling();
  block.remove();
  if ($isParagraphNode(previous)) previous.selectEnd();
  else if ($isParagraphNode(next)) next.selectStart();
  else {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraph.selectStart();
  }
}
