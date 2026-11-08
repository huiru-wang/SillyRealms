import {
  $applyNodeReplacement,
  ParagraphNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedParagraphNode,
  type Spread,
} from 'lexical';
import type {RoleplayKind} from '@sillyrealms/roleplay';

export type RoleplayBlockKind = Extract<RoleplayKind, 'thought' | 'speech' | 'instruction'>;
type SerializedRoleplayBlockNode = Spread<{
  kind: RoleplayBlockKind;
  type: 'sr-roleplay-block';
  version: 1;
}, SerializedParagraphNode>;

/** A semantic, block-level paragraph. Unlike the previous Inline implementation, each node owns a full row. */
export class RoleplayBlockNode extends ParagraphNode {
  __kind: RoleplayBlockKind;

  static getType(): string { return 'sr-roleplay-block'; }
  static clone(node: RoleplayBlockNode): RoleplayBlockNode {
    return new RoleplayBlockNode(node.__kind, node.__key);
  }

  constructor(kind: RoleplayBlockKind, key?: NodeKey) {
    super(key);
    this.__kind = kind;
  }

  static importJSON(serialized: SerializedRoleplayBlockNode): RoleplayBlockNode {
    return $createRoleplayBlockNode(serialized.kind).updateFromJSON(serialized);
  }

  exportJSON(): SerializedRoleplayBlockNode {
    return {...super.exportJSON(), type: 'sr-roleplay-block', version: 1, kind: this.__kind};
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.classList.add('sr-composer-block', `sr-composer-${this.__kind}`);
    element.dataset.kind = this.__kind;
    const label = this.__kind === 'thought' ? '内心' : this.__kind === 'speech' ? '话语' : '叙事指令';
    element.dataset.label = label;
    element.setAttribute('aria-label', `${label}输入块`);
    return element;
  }

  updateDOM(previous: this, dom: HTMLElement, config: EditorConfig): boolean {
    if (previous.__kind !== this.__kind) return true;
    return super.updateDOM(previous, dom, config);
  }

  getKind(): RoleplayBlockKind { return this.getLatest().__kind; }
}

export function $createRoleplayBlockNode(kind: RoleplayBlockKind): RoleplayBlockNode {
  return $applyNodeReplacement(new RoleplayBlockNode(kind));
}
export function $isRoleplayBlockNode(node: LexicalNode | null | undefined): node is RoleplayBlockNode {
  return node instanceof RoleplayBlockNode;
}
