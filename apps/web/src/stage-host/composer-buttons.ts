import {readComposerButtonList, type ComposerButtonView} from '../../../../packages/sr-sdk/src/stage/composer-buttons.ts';

export type HostedComposerButton = ComposerButtonView & {click(): void};

export function bindComposerButtons(port: Pick<MessagePort, 'postMessage'>, display: (buttons: HostedComposerButton[]) => void) {
  let revision = 0;
  let closed = false;
  return {
    receive(payload: unknown) {
      const list = readComposerButtonList(payload);
      if (closed || !list || list.revision <= revision) return;
      revision = list.revision;
      display(list.buttons.map(button => ({
        ...button,
        click() {
          if (!closed && revision === list.revision && !button.disabled)
            port.postMessage({type: 'composer-button-click', revision, id: button.id});
        },
      })));
    },
    close() {
      closed = true;
      if (revision) display([]);
    },
  };
}
