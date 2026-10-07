// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// "Click outside to close" for a modal <dialog>, done so it cannot eat a form.
//
// A bare `click` listener checking `event.target === dialog` also fires when a
// press starts inside the dialog (selecting text in a password field) and the
// release lands outside it: the click goes to the nearest common ancestor,
// which is the dialog. That used to close a half-filled form mid-typing. Here
// both the press and the release have to be outside `surface`.
export function dismissOnBackdrop(
  dialog: HTMLDialogElement,
  surface: HTMLElement,
  dismiss: () => void,
): void {
  let pressedOutside = false;
  const outside = (event: MouseEvent): boolean => {
    if (event.target !== dialog) return false;
    const box = surface.getBoundingClientRect();
    // No layout (jsdom, or not rendered yet): only the dialog itself is left.
    if (box.width === 0 && box.height === 0) return true;
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    );
  };
  dialog.addEventListener('pointerdown', (event) => {
    pressedOutside = outside(event);
  });
  dialog.addEventListener('click', (event) => {
    const dismissed = pressedOutside && outside(event);
    pressedOutside = false;
    if (dismissed) dismiss();
  });
}
