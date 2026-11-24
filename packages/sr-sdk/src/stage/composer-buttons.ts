export type ComposerButtonView = {id: string; label: string; disabled?: boolean};
export type SRComposerButton = ComposerButtonView & {onClick(): void | Promise<void>};
export type ComposerButtonList = {revision: number; buttons: ComposerButtonView[]};

const limit = 5;
function validButton(value: unknown): value is ComposerButtonView {
  if (!value || typeof value !== 'object') return false;
  const {id, label, disabled} = value as ComposerButtonView;
  return typeof id === 'string' && id.length <= 128 && !!id.trim() &&
    typeof label === 'string' && label.length <= 256 && !!label.trim() &&
    (disabled === undefined || typeof disabled === 'boolean');
}
function view({id, label, disabled}: ComposerButtonView): ComposerButtonView {
  return {id, label, disabled: disabled === true};
}

/** Validate untrusted frame data and only retain fields rendered by the Host. */
export function readComposerButtonList(payload: unknown): ComposerButtonList | null {
  if (!payload || typeof payload !== 'object') return null;
  const {revision, buttons} = payload as ComposerButtonList;
  if (!Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(buttons) || buttons.length > limit) return null;
  const ids = new Set<string>();
  const result: ComposerButtonView[] = [];
  for (const button of buttons) {
    if (!validButton(button) || ids.has(button.id)) return null;
    ids.add(button.id);
    result.push(view(button));
  }
  return {revision, buttons: result};
}

/** A single stage declaration and its callbacks belong to one frame connection. */
export class StageComposerButtons {
  private revision = 0;
  private owner: symbol | null = null;
  private buttons: SRComposerButton[] = [];
  private readonly publish: (list: ComposerButtonList) => void;

  constructor(publish: (list: ComposerButtonList) => void) { this.publish = publish; }

  update(owner: symbol, declaration: readonly SRComposerButton[]) {
    if (this.owner !== null && this.owner !== owner) throw Error('stage:commands.singleComposerOwner');
    this.owner = owner;
    const next: SRComposerButton[] = [];
    for (const button of declaration.slice(0, limit)) {
      if (!validButton(button) || typeof button.onClick !== 'function' || next.some(item => item.id === button.id)) continue;
      next.push({...view(button), onClick: button.onClick});
    }
    if (next.length === this.buttons.length && next.every((button, index) => {
      const old = this.buttons[index];
      return button.id === old.id && button.label === old.label && button.disabled === old.disabled && button.onClick === old.onClick;
    })) return;
    this.buttons = next;
    this.publish({revision: ++this.revision, buttons: next.map(view)});
  }

  release(owner: symbol) {
    if (this.owner !== owner) return;
    this.update(owner, []);
    this.owner = null;
  }

  async click(revision: unknown, id: unknown) {
    if (revision !== this.revision) return;
    const button = this.buttons.find(item => item.id === id);
    if (button && !button.disabled) await button.onClick();
  }
}
