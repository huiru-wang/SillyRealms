/** Keep focus restoration accessible without showing a keyboard ring after a pointer close. */
export function restoreDialogFocus(target: HTMLElement, keyboard: boolean) {
  if (!target.isConnected) return;
  if (!keyboard) {
    target.setAttribute('data-pointer-focus', '');
    const clear = () => {
      target.removeAttribute('data-pointer-focus');
      target.removeEventListener('blur', clear);
      target.removeEventListener('keydown', clear);
    };
    target.addEventListener('blur', clear);
    target.addEventListener('keydown', clear);
  } else target.removeAttribute('data-pointer-focus');
  target.focus({ preventScroll: true });
}
